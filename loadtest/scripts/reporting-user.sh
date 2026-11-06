#!/usr/bin/env bash
# QuickSight database login: gives the reporting_ro role (migration 0004) a fresh random password and stores it in
# Secrets Manager as {"username", "password"}, the format QuickSight reads (infra/modules/quicksight).
#
#   scripts/reporting-user.sh            # rotate (default): new password in RDS, then in the secret; re-run to rotate
#   scripts/reporting-user.sh disable    # NOLOGIN + no password in RDS, then delete the secret (teardown)
#   DRY_RUN=1 scripts/reporting-user.sh  # read-only lookups; prints the ECS Exec and Secrets Manager calls
#
# The password is generated here and written only to a mktemp file (mode 600, removed on exit) that the AWS CLI reads
# with file://. RDS is private, so the role is changed inside a running API task through ECS Exec, like
# nfr3-oversell-check.sh, with the task's own `pg` package and DB env (the master user from the RDS-managed secret).
# Only a SCRAM-SHA-256 verifier (salted hash) crosses ECS Exec, never the password: the ExecuteCommand call and its
# command line end up in CloudTrail. Needs ECS Exec on the service and the session-manager-plugin locally.
SERVICE_KEY="${SERVICE_KEY:-organiser}" # any API service works; UC5's by default (lib.sh keeps an explicit value)
source "$(dirname "$0")/lib.sh"

ACTION="${1:-rotate}"
[[ "$ACTION" == "rotate" || "$ACTION" == "disable" ]] || die "usage: $0 [rotate|disable]"
ROLE=reporting_ro
SECRET_NAME="${SECRET_NAME:-$NAME/quicksight/reporting-ro}"
command -v node >/dev/null || die "node is needed locally to generate the password"

umask 077
SECRET_JSON="$(mktemp)"
RAW="$(mktemp)"
trap 'rm -f "$SECRET_JSON" "$RAW"' EXIT

VERIFIER_B64=""
if [[ "$ACTION" == "rotate" ]]; then
  # 24 random bytes as hex: 48 characters, no quoting issues anywhere. The verifier follows PostgreSQL's SCRAM-SHA-256
  # format (RFC 5802 / RFC 7677: StoredKey = H(HMAC(SaltedPassword, "Client Key")), ServerKey = HMAC(SaltedPassword,
  # "Server Key")), so ALTER ROLE stores it as is.
  VERIFIER_B64="$(node -e '
    const c = require("crypto");
    const fs = require("fs");
    const password = c.randomBytes(24).toString("hex");
    const salt = c.randomBytes(16);
    const iterations = 4096;
    const salted = c.pbkdf2Sync(password, salt, iterations, 32, "sha256");
    const hmac = (key, s) => c.createHmac("sha256", key).update(s).digest();
    const storedKey = c.createHash("sha256").update(hmac(salted, "Client Key")).digest();
    const serverKey = hmac(salted, "Server Key");
    fs.writeFileSync(process.argv[1], JSON.stringify({ username: process.argv[2], password }), { mode: 0o600 });
    const b64 = (b) => b.toString("base64");
    const verifier = `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
    process.stdout.write(Buffer.from(verifier).toString("base64"));
  ' "$SECRET_JSON" "$ROLE")"
  [[ -n "$VERIFIER_B64" && -s "$SECRET_JSON" ]] || die "password generation failed"
fi

# 1. The database. gzip + base64 keeps the command free of quotes and well under the ECS Exec command length.
require_aws
PAYLOAD="$(gzip -9c "$LOADTEST_DIR/sql/reporting-role.js" | base64 | tr -d '\n')"
RUN="echo $PAYLOAD | base64 -d | gunzip | ROLE_ACTION=$ACTION ROLE_VERIFIER_B64=$VERIFIER_B64 node -"
TASK="${TASK_ARN:-$(running_task_arn)}"
[[ "$TASK" != "None" && -n "$TASK" ]] || die "no running task in $CLUSTER/$SERVICE (SERVICE_KEY= picks another API service)"
EXEC_ENABLED="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].enableExecuteCommand' --output text)"
[[ "$EXEC_ENABLED" == "True" ]] || die "ECS Exec is off for $TASK: set enable_execute_command = true, apply, and let the service start a new task"
log "$ACTION $ROLE in $TASK (container $CONTAINER)"
mutate aws ecs execute-command --cluster "$CLUSTER" --task "$TASK" --container "$CONTAINER" --interactive \
  --command "sh -c 'cd /app && $RUN'" | tee "$RAW"
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: database unchanged"
else
  LINE="$(tr -d '\r' < "$RAW" | grep -m1 '^REPORTING_ROLE_RESULT ' | sed 's/^REPORTING_ROLE_RESULT //')" || true
  [[ -n "$LINE" ]] || die "no REPORTING_ROLE_RESULT line in the output above; the secret was not changed"
  jq -e '.pass == true' <<<"$LINE" >/dev/null || die "role check failed (see the result above); the secret was not changed"
fi

# 2. The secret, only after the database accepted the new password, so it never holds a password RDS doesn't know.
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null)" || SECRET_ARN=""
if [[ "$ACTION" == "rotate" ]]; then
  if [[ -n "$SECRET_ARN" ]]; then
    mutate aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "file://$SECRET_JSON" \
      --query VersionId --output text >/dev/null
    log "new version of $SECRET_NAME stored"
  else
    mutate aws secretsmanager create-secret --name "$SECRET_NAME" \
      --description "QuickSight login for database role $ROLE (written by loadtest/scripts/reporting-user.sh)" \
      --secret-string "file://$SECRET_JSON" \
      --tags Key=Project,Value=TicketMastery Key=Owner,Value=elroy Key=ManagedBy,Value=reporting-user.sh \
      --query ARN --output text >/dev/null
    log "$SECRET_NAME created"
  fi
  log "QuickSight reads the new password on its next connection; no Terraform change needed"
elif [[ -n "$SECRET_ARN" ]]; then
  mutate aws secretsmanager delete-secret --secret-id "$SECRET_ARN" --force-delete-without-recovery >/dev/null
  log "$SECRET_NAME deleted"
else
  log "$SECRET_NAME does not exist"
fi
