#!/usr/bin/env bash
# Records the API service's task counts every INTERVAL seconds until stopped (Ctrl-C / kill), as CSV:
#   time_utc,desired,running,pending,deployments
#
#   scripts/ecs-watch.sh results/ecs-tasks.csv [INTERVAL=15]
# Read-only (ecs:DescribeServices). scripts/nfr2-burst.sh starts and stops it around the burst.
source "$(dirname "$0")/lib.sh"

require_aws
OUT="${1:?usage: ecs-watch.sh OUT.csv [interval]}"
INTERVAL="${2:-15}"
echo "time_utc,desired,running,pending,deployments" > "$OUT"
trap 'log "ecs-watch stopped ($OUT)"; exit 0' INT TERM
while true; do
  line="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].[desiredCount,runningCount,pendingCount,length(deployments)]' --output text 2>/dev/null | tr '\t' ',')" \
    || line="error,,,"
  echo "$(iso_now),$line" >> "$OUT"
  sleep "$INTERVAL" & wait $!
done
