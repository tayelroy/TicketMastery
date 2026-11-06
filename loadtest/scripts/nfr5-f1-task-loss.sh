#!/usr/bin/env bash
# NFR-5 / drill F1: lose an API task and time the outage seen through API Gateway.
# Stops the running task of the discovery ECS service (the ALB default, which answers /health; with another
# SERVICE_KEY the /health probe would not see the outage), polls
# GET <api>/health every POLL seconds, and records when it first fails and when it is 200 again (STABLE consecutive
# 200s). ECS then starts a replacement and the ALB health check admits it. With two or more tasks in that service the
# expected outage is zero; the other services keep serving their routes throughout.
#
#   scripts/nfr5-f1-task-loss.sh                                   # AWS (BASE_URL defaults to the API Gateway URL)
#   TARGET=local BASE_URL=http://localhost:3000 STOP_CMD="docker restart ticketmastery-api-1" scripts/nfr5-f1-task-loss.sh
# DRY_RUN=1 prints the stop-task call and only polls.
source "$(dirname "$0")/lib.sh"

TARGET="${TARGET:-aws}"
POLL="${POLL:-1}"
STABLE="${STABLE:-10}"
TIMEOUT="${TIMEOUT:-900}"
NO_OUTAGE_WAIT="${NO_OUTAGE_WAIT:-180}" # stop watching after this long if /health never failed (2+ tasks)
if [[ "$TARGET" == aws ]]; then
  require_aws
  BASE_URL="$(api_url)"
  TASK="$(running_task_arn)"
  [[ "$TASK" != "None" && -n "$TASK" ]] || die "no running task in $CLUSTER/$SERVICE"
  TASKS_BEFORE="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].runningCount' --output text)"
  STOP=(aws ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason "F1 drill (loadtest/scripts/nfr5-f1-task-loss.sh)" --query 'task.lastStatus' --output text)
else
  [[ -n "${BASE_URL:-}" && -n "${STOP_CMD:-}" ]] || die "TARGET=local needs BASE_URL and STOP_CMD"
  TASK="local"; TASKS_BEFORE=1
  STOP=(sh -c "$STOP_CMD")
fi
HEALTH="${BASE_URL%/}/health"

probe() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH" || true; }
[[ "$(probe)" == 200 ]] || die "$HEALTH is not 200 before the drill; fix that first"

result_files nfr5-f1
CSV="${RESULT_JSON%.json}.csv"
echo "time_utc,elapsed_s,http_status" > "$CSV"

T0="$(epoch)"; T0_ISO="$(iso_now)"
log "stopping $TASK at $T0_ISO ($TASKS_BEFORE task(s) running)"
mutate "${STOP[@]}" > /dev/null &
STOP_PID=$!

OUTAGE_START=""; OUTAGE_END=""; OK_RUN=0; FAILS=0; LAST=""
while true; do
  NOW="$(epoch)"; CODE="$(probe)"; [[ -n "$CODE" ]] || CODE=000
  echo "$(iso_now),$((NOW - T0)),$CODE" >> "$CSV"
  [[ "$CODE" != "$LAST" ]] && log "+$((NOW - T0))s /health -> $CODE"
  LAST="$CODE"
  if [[ "$CODE" == 200 ]]; then
    OK_RUN=$((OK_RUN + 1))
    if [[ -n "$OUTAGE_START" && -z "$OUTAGE_END" ]]; then OUTAGE_END="$NOW"; fi
    # Done: recovered and stable, or no outage at all after a generous wait (task stopped, others kept serving).
    if [[ -n "$OUTAGE_END" && "$OK_RUN" -ge "$STABLE" ]]; then break; fi
    if [[ -z "$OUTAGE_START" && $((NOW - T0)) -ge "$NO_OUTAGE_WAIT" ]]; then break; fi
  else
    FAILS=$((FAILS + 1)); OK_RUN=0
    [[ -z "$OUTAGE_START" ]] && OUTAGE_START="$NOW"
    OUTAGE_END="" # a flap after recovery extends the outage
  fi
  (( NOW - T0 < TIMEOUT )) || { log "gave up after ${TIMEOUT}s"; break; }
  sleep "$POLL"
done
wait "$STOP_PID" 2>/dev/null || true

NEW_TASK=""
if [[ "$TARGET" == aws && "$DRY_RUN" != 1 ]]; then
  NEW_TASK="$(running_task_arn)"
  EVENTS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json |
    jq --arg s "$T0_ISO" '[.services[0].events[] | select(.createdAt >= $s) | {createdAt, message}] | sort_by(.createdAt)')"
else
  EVENTS="[]"
fi

jq -n --arg task "$TASK" --arg newTask "$NEW_TASK" --arg t0 "$T0_ISO" --arg health "$HEALTH" --arg csv "$CSV" \
  --argjson tasksBefore "$TASKS_BEFORE" --argjson t0e "$T0" --argjson fails "$FAILS" --argjson poll "$POLL" \
  --arg os "$OUTAGE_START" --arg oe "$OUTAGE_END" --argjson events "$EVENTS" --arg dry "$DRY_RUN" '
  {test: "nfr5-f1", dryRun: ($dry == "1"), stoppedTask: $task, replacementTask: $newTask, tasksBefore: $tasksBefore,
   stoppedAt: $t0, health: $health, pollSeconds: $poll, failedProbes: $fails, timeline: $csv,
   firstFailureAfterSec: (if $os == "" then null else (($os | tonumber) - $t0e) end),
   healthyAgainAfterSec: (if $oe == "" then null else (($oe | tonumber) - $t0e) end),
   outageSec: (if $os == "" then 0 elif $oe == "" then null else (($oe | tonumber) - ($os | tonumber)) end),
   serviceEvents: $events}
  | .pass = (.outageSec != null and .outageSec <= 300)' > "$RESULT_JSON"

jq -r '
  def cell: if . == null then "not recovered" else tostring end;
  "# nfr5-f1: lose the API task (\(.stoppedAt))\(if .dryRun then " DRY RUN: task NOT stopped, not evidence" else "" end)\n",
  "| Tasks before | First failed /health (s after stop) | /health 200 again (s after stop) | Outage (s) | Failed probes (every \(.pollSeconds) s) | RTO ≤ 5 min |",
  "| --- | --- | --- | --- | --- | --- |",
  "| \(.tasksBefore) | \(.firstFailureAfterSec // "none") | \(.healthyAgainAfterSec // "n/a") | \(.outageSec | cell) | \(.failedProbes) | \(if .pass then "PASS" else "FAIL" end) |\n",
  "Stopped `\(.stoppedTask)`; replacement `\(.replacementTask)`. Probe log: \(.timeline)\n",
  (.serviceEvents[] | "- \(.createdAt): \(.message)")
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON, .md and .csv"
