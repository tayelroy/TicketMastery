# Shared settings for loadtest/scripts/*.sh (sourced, not run). Every name can be overridden from the environment.
# Resource names follow infra/envs/dev (name prefix ticketmastery-dev).
set -euo pipefail

LOADTEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$LOADTEST_DIR/results}"
STATE_DIR="${STATE_DIR:-$LOADTEST_DIR/state}"
mkdir -p "$RESULTS_DIR" "$STATE_DIR"

# The shell's own AWS_PROFILE may point at another account, so the project profile is pinned here; override it with
# TM_AWS_PROFILE. require_aws refuses to run against any account but EXPECTED_ACCOUNT.
export AWS_PROFILE="${TM_AWS_PROFILE:-ticketmastery-tf}"
export AWS_REGION="${TM_AWS_REGION:-ap-southeast-1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-000246635159}"
export AWS_PAGER=""
export TZ=UTC # AWS CLI prints timestamps in the local zone otherwise

require_aws() {
  local account
  account="$(aws sts get-caller-identity --query Account --output text)" || die "AWS credentials for profile $AWS_PROFILE don't work"
  [[ "$account" == "$EXPECTED_ACCOUNT" ]] || die "profile $AWS_PROFILE is account $account, expected $EXPECTED_ACCOUNT"
}

NAME="${NAME:-ticketmastery-dev}"
CLUSTER="${CLUSTER:-$NAME-cluster}"
# The API runs as one ECS service per use case (ticketmastery-dev-<key>: discovery, account, waiting-room, checkout,
# organiser). SERVICE_KEY picks the one the ECS/ALB scripts look at; discovery (UC1 browse) is the default because it
# serves the browse load tests and /health. Its target group is <name>-<key>-tg, except waiting-room (-wroom-tg).
SERVICE_KEY="${SERVICE_KEY:-discovery}"
SERVICE="${SERVICE:-$NAME-$SERVICE_KEY}"
CONTAINER="${CONTAINER:-ticketmastery-api}"
DB_INSTANCE="${DB_INSTANCE:-$NAME-postgres}"
ALB_NAME="${ALB_NAME:-$NAME-alb}"
TARGET_GROUP_NAME="${TARGET_GROUP_NAME:-$NAME-$([[ "$SERVICE_KEY" == waiting-room ]] && echo wroom || echo "$SERVICE_KEY")-tg}"
SERVICE_KEYS=(discovery account waiting-room checkout organiser)
TICKET_FN_LOG_GROUP="${TICKET_FN_LOG_GROUP:-/aws/lambda/$NAME-ticket-fn}"
TICKET_QUEUE_NAME="${TICKET_QUEUE_NAME:-$NAME-ticket-queue}"
USER_POOL_NAME="${USER_POOL_NAME:-$NAME-users}"
USER_POOL_CLIENT_NAME="${USER_POOL_CLIENT_NAME:-$NAME-spa}"
HTTP_API_NAME="${HTTP_API_NAME:-$NAME-http-api}"

# DRY_RUN=1: AWS calls that change something are printed instead of run (read-only calls still run).
DRY_RUN="${DRY_RUN:-0}"

stamp() { date -u +%Y%m%dT%H%M%SZ; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
epoch() { date -u +%s; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Mutating command: run it, or print it under DRY_RUN=1.
mutate() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'DRY_RUN would run:' >&2; printf ' %q' "$@" >&2; printf '\n' >&2
  else
    "$@"
  fi
}

# Seconds since the epoch for an ISO-8601 timestamp (GNU or BSD date).
to_epoch() {
  local t="${1%%.*}"; t="${t%Z}"; t="${t%+00:00}"
  date -u -d "$t" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%S' "$t" +%s
}

# ISO timestamp N seconds ago (GNU or BSD date).
iso_ago() { date -u -d "@$(( $(epoch) - $1 ))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$(( $(epoch) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }

api_url() {
  if [[ -n "${BASE_URL:-}" ]]; then echo "${BASE_URL%/}"; return; fi
  aws apigatewayv2 get-apis --query "Items[?Name=='$HTTP_API_NAME'].ApiEndpoint | [0]" --output text
}

running_task_arn() {
  aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING \
    --query 'taskArns[0]' --output text
}

alb_dimension() { # app/<name>/<id>
  aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text | sed 's#.*:loadbalancer/##'
}

tg_dimension() { # targetgroup/<name>/<id>
  aws elbv2 describe-target-groups --names "$TARGET_GROUP_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text | sed 's#.*:##'
}

# result_files <test> -> sets RESULT_JSON / RESULT_MD for this run
result_files() {
  local ts; ts="$(stamp)"
  RESULT_JSON="$RESULTS_DIR/$1-$ts.json"
  RESULT_MD="$RESULTS_DIR/$1-$ts.md"
}
