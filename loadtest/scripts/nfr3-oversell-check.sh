#!/usr/bin/env bash
# NFR-3 SQL check: no seat in two confirmed orders; sold seats match confirmed order lines.
#
#   scripts/nfr3-oversell-check.sh [concertId]            # TARGET=aws (default): inside the running ECS task (ECS Exec)
#   TARGET=local DB_NAME=ticketmastery scripts/nfr3-oversell-check.sh [concertId]   # docker-compose Postgres
#
# AWS: RDS is private, so the check runs in the API container with its own `pg` package and DB env (DB_HOST, DB_NAME,
# DB_SSL from the task definition; DB_USER / DB_PASSWORD injected from the RDS-managed secret). Needs ECS Exec on the
# service (enable_execute_command = true, which also grants ssmmessages:* to the task role) and the
# session-manager-plugin locally. Without a concert id every concert is checked.
source "$(dirname "$0")/lib.sh"

CONCERT_ID="${1:-}"
TARGET="${TARGET:-aws}"
# DB_HOST_OVERRIDE: check another instance with the task's credentials (the F4 drill's restored copy).
[[ -z "${DB_HOST_OVERRIDE:-}" || "$DB_HOST_OVERRIDE" =~ ^[A-Za-z0-9.-]+$ ]] || die "bad DB_HOST_OVERRIDE"
[[ -z "$CONCERT_ID" || "$CONCERT_ID" =~ ^[0-9a-f-]{36}$ ]] || die "concert id must be a uuid"

# gzip + base64 keeps the command free of quotes and well under the ECS Exec command length.
PAYLOAD="$(gzip -9c "$LOADTEST_DIR/sql/oversell-check.js" | base64 | tr -d '\n')"
RUN="echo $PAYLOAD | base64 -d | gunzip | CONCERT_ID=$CONCERT_ID ${DB_HOST_OVERRIDE:+DB_HOST=$DB_HOST_OVERRIDE }node -"
RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

if [[ "$TARGET" == "local" ]]; then
  API_DIR="$LOADTEST_DIR/../services/ticketmastery-api"
  [[ -d "$API_DIR/node_modules/pg" ]] || die "run npm ci in services/ticketmastery-api first (needs its pg package)"
  (cd "$API_DIR" && DB_HOST="${DB_HOST:-localhost}" DB_PORT="${DB_PORT:-5432}" DB_NAME="${DB_NAME:-ticketmastery}" \
    DB_USER="${DB_USER:-tm}" DB_PASSWORD="${DB_PASSWORD:-tm_local_dev_only}" DB_SSL="${DB_SSL:-false}" \
    sh -c "$RUN") | tee "$RAW"
else
  require_aws
  TASK="${TASK_ARN:-$(running_task_arn)}"
  [[ "$TASK" != "None" && -n "$TASK" ]] || die "no running task in $CLUSTER/$SERVICE"
  EXEC_ENABLED="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].enableExecuteCommand' --output text)"
  [[ "$EXEC_ENABLED" == "True" ]] || die "ECS Exec is off for $TASK: set enable_execute_command = true, apply, and let the service start a new task"
  log "running the check in $TASK (container $CONTAINER)"
  aws ecs execute-command --cluster "$CLUSTER" --task "$TASK" --container "$CONTAINER" --interactive \
    --command "sh -c 'cd /app && $RUN'" | tee "$RAW"
fi

LINE="$(tr -d '\r' < "$RAW" | grep -m1 '^OVERSELL_CHECK_RESULT ' | sed 's/^OVERSELL_CHECK_RESULT //')" || true
[[ -n "$LINE" ]] || die "no OVERSELL_CHECK_RESULT line in the output above"

result_files nfr3-oversell-sql
jq --arg target "$TARGET" '. + {target: $target}' <<<"$LINE" > "$RESULT_JSON"
jq -r '
  if .error then "SQL check failed: \(.error)" else
  "# nfr3-oversell-sql (\(.checked_at))\n\nScope: \(.scope), database \(.db) (TARGET=\(.target))\n\n" +
  "| Confirmed orders | Seats in confirmed orders | Seats with status sold | Seats in 2+ confirmed orders | Sold seat without a confirmed order | Confirmed seat not sold to its order | NFR-3 |\n" +
  "| --- | --- | --- | --- | --- | --- | --- |\n" +
  "| \(.confirmed_orders) | \(.confirmed_order_seats) | \(.sold_seats) | \(.seats_in_two_confirmed_orders) | \(.sold_without_confirmed_order) | \(.confirmed_seat_not_sold_to_order) | \(if .pass then "PASS" else "FAIL" end) |" end
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON and .md"
jq -e '.pass == true' "$RESULT_JSON" >/dev/null
