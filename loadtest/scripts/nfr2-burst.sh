#!/usr/bin/env bash
# NFR-2 burst run with the evidence around it:
#   1. records the ECS task count every 15 s (scripts/ecs-watch.sh) while
#   2. k6/nfr2-burst.js ramps BASE_RPS -> BASE_RPS*MULT and holds it, then
#   3. collects the Application Auto Scaling activities and ECS service events of the window, and
#   4. the ALB / ECS CloudWatch metrics per minute (scripts/alb-metrics.sh),
# and writes results/nfr2-burst-aws-<ts>.md with tasks over time and the scale-out time.
#
#   AUTH=cognito BASE_RPS=10 MULT=10 WARM=2m RAMP=1m HOLD=10m COOL=3m scripts/nfr2-burst.sh
#   TARGET=local BASE_URL=http://localhost:3000 BASE_RPS=2 HOLD=30s ... scripts/nfr2-burst.sh   # k6 only
# BASE_URL defaults to the API Gateway URL. Turn autoscaling on before (enable_autoscaling = true, max 3).
source "$(dirname "$0")/lib.sh"

TARGET="${TARGET:-aws}"
ECS_WATCH="${ECS_WATCH:-$([[ "$TARGET" == aws ]] && echo 1 || echo 0)}"
METRICS_DELAY="${METRICS_DELAY:-120}" # CloudWatch ALB metrics lag about a minute
WARM="${WARM:-2m}"; RAMP="${RAMP:-1m}"; HOLD="${HOLD:-10m}"; COOL="${COOL:-3m}"
export WARM RAMP HOLD COOL

secs() { local n="${1%?}"; case "${1: -1}" in s) echo "$n" ;; m) echo $((n * 60)) ;; h) echo $((n * 3600)) ;; *) die "bad duration $1" ;; esac; }

[[ "$TARGET" == aws || "$ECS_WATCH" == 1 ]] && require_aws
if [[ "$TARGET" == aws ]]; then
  BASE_URL="$(api_url)"
  [[ "$(aws application-autoscaling describe-scalable-targets --service-namespace ecs \
      --resource-ids "service/$CLUSTER/$SERVICE" --query 'length(ScalableTargets)' --output text)" != "0" ]] \
    || log "WARNING: no scalable target for $SERVICE: autoscaling is off, the task count will stay flat"
fi
export BASE_URL

result_files nfr2-burst-aws
CSV="${RESULT_JSON%.json}-ecs.csv"
if [[ "$ECS_WATCH" == 1 ]]; then
  "$LOADTEST_DIR/scripts/ecs-watch.sh" "$CSV" 15 &
  WATCH_PID=$!
  trap 'kill $WATCH_PID 2>/dev/null || true' EXIT
fi

START="$(iso_now)"
log "burst starts $START against $BASE_URL"
(cd "$LOADTEST_DIR" && k6 run k6/nfr2-burst.js) || log "k6 exited non-zero (thresholds crossed are reported in the summary)"
END="$(iso_now)"

if [[ "$ECS_WATCH" == 1 ]]; then
  log "watching the task count ${METRICS_DELAY}s more (scale-in / metrics delay)"
  sleep "$METRICS_DELAY"
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
fi
[[ "$TARGET" == aws ]] || { log "TARGET=$TARGET: skipping AWS metrics"; exit 0; }

RAMP_START_EPOCH=$(( $(to_epoch "$START") + $(secs "$WARM") ))
ACTIVITIES="$(aws application-autoscaling describe-scaling-activities --service-namespace ecs \
  --resource-id "service/$CLUSTER/$SERVICE" --output json |
  jq --arg s "$START" '[.ScalingActivities[] | select(.StartTime >= $s) | {StartTime, EndTime, StatusCode, Description, Cause}] | sort_by(.StartTime)')"
EVENTS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json |
  jq --arg s "$START" '[.services[0].events[] | select(.createdAt >= $s) | {createdAt, message}] | sort_by(.createdAt)')"

"$LOADTEST_DIR/scripts/alb-metrics.sh" nfr2 "$START" "$END" >/dev/null

# Scale-out is judged on the desired count (a deployment also briefly runs an extra task without any scaling).
TASKS="$(tail -n +2 "$CSV" | { grep -v ',error' || true; } | jq -R -s --argjson ramp "$RAMP_START_EPOCH" '
  [split("\n")[] | select(length > 0) | split(",") | {time: .[0], desired: (.[1] | tonumber), running: (.[2] | tonumber)}] as $rows
  | ($rows[0].desired) as $initial
  | ([$rows[].desired] | max) as $maxDesired
  | ($rows | map(select(.desired > $initial)) | first) as $firstUp
  | ($rows | map(select($maxDesired > $initial and .running >= $maxDesired)) | first) as $reachedMax
  | def mins(t): if t == null then null else (((t.time | fromdateiso8601) - $ramp) / 6 | round / 10) end;
  {initialTasks: $initial, maxTasks: $maxDesired, maxRunning: ([$rows[].running] | max),
   scaleOutDecidedAt: $firstUp.time, scaleOutDecidedMinAfterRamp: mins($firstUp),
   maxTasksRunningAt: $reachedMax.time, scaleOutCompleteMinAfterRamp: mins($reachedMax),
   samples: $rows}')"

jq -n --arg start "$START" --arg end "$END" --arg csv "$CSV" --argjson tasks "$TASKS" \
  --argjson activities "$ACTIVITIES" --argjson events "$EVENTS" \
  '{test: "nfr2-burst-aws", start: $start, end: $end, ecsCsv: $csv, tasks: $tasks, scalingActivities: $activities, serviceEvents: $events,
    scaleOutWithin5Min: ($tasks.scaleOutCompleteMinAfterRamp != null and $tasks.scaleOutCompleteMinAfterRamp <= 5)}' > "$RESULT_JSON"

jq -r '
  def cell: if . == null then "" else tostring end;
  "# nfr2-burst: ECS scaling (\(.start) to \(.end))\n",
  "| Tasks before | Max tasks | Scale-out decided (min after ramp start) | Max tasks running (min after ramp start) | Scale-out ≤ 5 min |",
  "| --- | --- | --- | --- | --- |",
  "| \(.tasks.initialTasks) | \(.tasks.maxTasks) | \(.tasks.scaleOutDecidedMinAfterRamp | cell) | \(.tasks.scaleOutCompleteMinAfterRamp | cell) | \(if .scaleOutWithin5Min then "PASS" else "FAIL / no scale-out" end) |\n",
  "Task count over time (every 15 s):\n",
  "| Time (UTC) | Desired | Running |", "| --- | --- | --- |",
  (.tasks.samples[] | "| \(.time) | \(.desired) | \(.running) |"),
  "\nScaling activities:\n",
  (.scalingActivities[] | "- \(.StartTime) \(.StatusCode): \(.Description)"),
  "\nECS service events:\n",
  (.serviceEvents[] | "- \(.createdAt): \(.message)")
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON, .md and $CSV; k6 timeline in results/nfr2-burst-*.md, ALB metrics in results/nfr2-alb-*.md"
