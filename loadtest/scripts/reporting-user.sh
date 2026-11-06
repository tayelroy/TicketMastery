#!/usr/bin/env bash
# Database login of the reporting ECS service: gives the read-only reporting_ro role (migration 0004) a fresh random
# password and stores it in the Secrets Manager secret <name>/reporting/reporting-ro as {"username", "password"}, the
# keys the reporting task definition reads into DB_USER/DB_PASSWORD. Terraform creates that secret without a value
# (infra/modules/rds); this script writes every value. Deploy order: docs/deploy.md.
#
#   scripts/reporting-user.sh            # rotate (default): new password in RDS, then in the secret, then a new
#                                        # deployment of the reporting service (if it exists); re-run to rotate
#   scripts/reporting-user.sh disable    # NOLOGIN + no password in RDS (kill switch / teardown); the secret stays
#   DRY_RUN=1 scripts/reporting-user.sh  # read-only lookups; prints the ECS Exec, Secrets Manager and ECS calls
#
# The password is generated here and written only to a mktemp file (mode 600, removed on exit) that the AWS CLI reads
# with file://; it is never printed. RDS is private, so the role is changed inside a running API task through ECS Exec,
# like nfr3-oversell-check.sh, with the task's own `pg` package and DB env. That task must have the master user (from
# the RDS-managed secret): organiser by default, any service but reporting (reporting_ro can't ALTER ROLE). Only a
# SCRAM-SHA-256 verifier (salted hash) crosses ECS Exec, never the password: the ExecuteCommand call and its command
# line end up in CloudTrail. Needs ECS Exec on the service and the session-manager-plugin locally.
SERVICE_KEY="${SERVICE_KEY:-organiser}" # lib.sh keeps an explicit value
source "$(dirname "$0")/lib.sh"

ACTION="${1:-rotate}"
[[ "$ACTION" == "rotate" || "$ACTION" == "disable" ]] || die "usage: $0 [rotate|disable]"
[[ "$SERVICE_KEY" != "reporting" ]] || die "SERVICE_KEY=reporting connects as reporting_ro itself; pick a service with the master user (default organiser)"
ROLE=reporting_ro
SECRET_NAME="${SECRET_NAME:-$NAME/reporting/reporting-ro}"
REPORTING_SERVICE="${REPORTING_SERVICE:-$NAME-reporting}"
command -v node >/dev/null || die "node is needed locally to generate the password"

umask 077
SECRET_JSON="$(mktemp)"
RAW="$(mktemp)"
trap 'rm -f "$SECRET_JSON" "$RAW"' EXIT

require_aws
# The secret first: rotating the password in RDS without a secret to store it in would lock the service out.
SECRET_ARN="$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null)" || SECRET_ARN=""
if [[ "$ACTION" == "rotate" && -z "$SECRET_ARN" ]]; then
  die "secret $SECRET_NAME does not exist: create it with Terraform first (terraform apply -target=module.rds.aws_secretsmanager_secret.reporting_ro, see docs/deploy.md)"
fi

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

if [[ "$ACTION" == "disable" ]]; then
  log "$ROLE can no longer log in: the reporting service's /health now fails (503) and its no-healthy-hosts alarm fires"
  log "$SECRET_NAME is left as is (Terraform owns it; its old password is useless). Re-run without arguments to re-enable"
  exit 0
fi

# 2. The secret, only after the database accepted the new password, so it never holds a password RDS doesn't know.
mutate aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "file://$SECRET_JSON" \
  --query VersionId --output text >/dev/null
log "new version of $SECRET_NAME stored"

# 3. ECS resolves secrets only when a task starts, so running reporting tasks still hold the old password (their open
# pool connections keep working; new ones fail) until they are replaced. Before the first full apply the service
# doesn't exist yet and its first tasks read this value.
STATUS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$REPORTING_SERVICE" --query 'services[0].status' --output text 2>/dev/null)" || STATUS=""
if [[ "$STATUS" == "ACTIVE" ]]; then
  mutate aws ecs update-service --cluster "$CLUSTER" --service "$REPORTING_SERVICE" --force-new-deployment \
    --query 'service.deployments[0].id' --output text >/dev/null
  log "new deployment of $REPORTING_SERVICE started; its tasks pick up the new password (watch: aws ecs describe-services)"
else
  log "$REPORTING_SERVICE does not exist yet; its tasks will read the secret when Terraform creates it"
fi
