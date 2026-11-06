#!/usr/bin/env bash
# Records the task counts of the watched API service ($SERVICE, default the discovery service; SERVICE_KEY=checkout
# etc. picks another) every INTERVAL seconds until stopped (Ctrl-C / kill), as CSV, plus the desired count of every
# API service (one ECS service per use case), so a run shows which services scaled:
#   time_utc,desired,running,pending,deployments,desired_discovery,desired_account,...
#
#   scripts/ecs-watch.sh results/ecs-tasks.csv [INTERVAL=15]
# Read-only (ecs:DescribeServices). scripts/nfr2-burst.sh starts and stops it around the burst.
source "$(dirname "$0")/lib.sh"

require_aws
OUT="${1:?usage: ecs-watch.sh OUT.csv [interval]}"
INTERVAL="${2:-15}"
ALL_SERVICES=("${SERVICE_KEYS[@]/#/$NAME-}")
ALL_EMPTY="$(printf ',%.0s' "${SERVICE_KEYS[@]:1}")" # n-1 commas = n empty fields
echo "time_utc,desired,running,pending,deployments$(printf ',desired_%s' "${SERVICE_KEYS[@]}")" > "$OUT"
trap 'log "ecs-watch stopped ($OUT)"; exit 0' INT TERM
while true; do
  line="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].[desiredCount,runningCount,pendingCount,length(deployments)]' --output text 2>/dev/null | tr '\t' ',')" \
    || line="error,,,"
  all="$(aws ecs describe-services --cluster "$CLUSTER" --services "${ALL_SERVICES[@]}" --output json 2>/dev/null |
    jq -r --args '[$ARGS.positional[] as $n | ([.services[] | select(.serviceName == $n) | .desiredCount][0] // "")] | map(tostring) | join(",")' \
      "${ALL_SERVICES[@]}")" || all="$ALL_EMPTY"
  echo "$(iso_now),$line,$all" >> "$OUT"
  sleep "$INTERVAL" & wait $!
done
