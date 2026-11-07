#!/usr/bin/env bash
# Flash-sale simulation on the live dev stack (plan: docs/plans/flash-sale-simulation.md):
#   1. preflight: account, admit batch, SES rate, RDS max_connections;
#   2. test fans + organiser (scripts/cognito-users.sh) and a fresh test concert (k6/setup-concert.js);
#   3. k6/flash-sale.js (fans + anonymous browsing) while scripts/ecs-watch.sh records tasks per service;
#   4. evidence: oversell SQL (nfr3-oversell-check.sh), e-tickets (nfr7-eticket.sh), alarms that fired, RDS/API
#      Gateway/waiting-room metrics, per-fan outcomes and admission fairness;
#   5. results/flash-sale-<ts>.md + .json. The test concert is always cancelled on exit (even after an error), so it
#      never stays in the public listing; KEEP_CONCERT=1 keeps it. CLEANUP=1 also deletes the test users.
#
#   PROFILE=smoke|standard|peak scripts/flash-sale.sh
#   PROFILE=peak BACKOFF=1 scripts/flash-sale.sh          # the 429 backoff fix from report section 2.2
#   FANS=200 SEATS=150 BROWSE_RPS=10 scripts/flash-sale.sh   # any profile value can be overridden
# Never touches the demo concert: it creates its own and uses load-test users only (SES mailbox simulator).
source "$(dirname "$0")/lib.sh"

# A run takes 5–20 minutes; on macOS keep the machine from sleeping meanwhile (a sleeping laptop pauses every fan).
if [[ "$(uname)" == Darwin && -z "${FLASH_SALE_AWAKE:-}" ]] && command -v caffeinate >/dev/null; then
  FLASH_SALE_AWAKE=1 exec caffeinate -dims "$0" "$@"
fi
PROFILE="${PROFILE:-smoke}"
case "$PROFILE" in
  smoke)    d_fans=40;  d_seats=30;  d_browse=5;  d_browse_dur=5m ;;
  standard) d_fans=400; d_seats=300; d_browse=20; d_browse_dur=8m ;;
  peak)     d_fans=999; d_seats=400; d_browse=20; d_browse_dur=10m ;;
  *) die "PROFILE must be smoke, standard or peak" ;;
esac
export FANS="${FANS:-$d_fans}" SEATS="${SEATS:-$d_seats}" BROWSE_RPS="${BROWSE_RPS:-$d_browse}"
export BROWSE_DURATION="${BROWSE_DURATION:-$d_browse_dur}" FAN_OFFSET="${FAN_OFFSET:-0}"
export ARRIVAL_SEC="${ARRIVAL_SEC:-60}" POLL_SEC="${POLL_SEC:-5}" BACKOFF="${BACKOFF:-0}"
SALE_OPENS_IN="${SALE_OPENS_IN:-30}"
DRAIN_SEC="${DRAIN_SEC:-240}"   # e-tickets keep going out after the last payment (SES: 1 email/s)
CLEANUP="${CLEANUP:-0}"
KEEP_CONCERT="${KEEP_CONCERT:-0}"
export AUTH=cognito

require_aws
BASE_URL="$(api_url)"; export BASE_URL
result_files flash-sale
TS="$(basename "$RESULT_JSON" .json | sed 's/^flash-sale-//')"
FANLOG="$RESULTS_DIR/flash-sale-$TS-fans.log"
CSV="$RESULTS_DIR/flash-sale-$TS-ecs.csv"

# --- 1. preflight ------------------------------------------------------------------------------------------------
BATCH="$(aws lambda get-function-configuration --function-name queue-manager \
  --query 'Environment.Variables.ADMIT_BATCH_SIZE' --output text 2>/dev/null || echo '?')"
SES_RATE="$(aws sesv2 get-account --query 'SendQuota.MaxSendRate' --output text 2>/dev/null || echo '?')"

# RDS is private: read max_connections inside a running API task (ECS Exec), like nfr3-oversell-check.sh.
db_query() { # $1 = SQL returning one row; prints the row as JSON
  local js payload task
  js="const {Client}=require('pg');(async()=>{const c=new Client({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,ssl:{rejectUnauthorized:false}});await c.connect();const r=await c.query(process.env.Q);console.log('DBQ '+JSON.stringify(r.rows[0]));await c.end();})().catch(e=>console.log('DBQ '+JSON.stringify({error:e.message})))"
  payload="$(printf '%s' "$js" | gzip -9c | base64 | tr -d '\n')"
  task="$(SERVICE="$NAME-organiser" running_task_arn)"
  aws ecs execute-command --cluster "$CLUSTER" --task "$task" --container "$CONTAINER" --interactive \
    --command "sh -c 'cd /app && echo $payload | base64 -d | gunzip | Q=\"$1\" node -'" 2>/dev/null |
    tr -d '\r' | grep -m1 '^DBQ ' | sed 's/^DBQ //' || echo '{}'
}
MAXCONN="$(db_query "SHOW max_connections" | jq -r '.max_connections // "?"')"
log "profile $PROFILE: $FANS fans, $SEATS seats, browse $BROWSE_RPS req/s, BACKOFF=$BACKOFF; admit batch $BATCH/min, SES $SES_RATE email/s, RDS max_connections $MAXCONN"
POLL_RPS=$(( FANS / POLL_SEC ))
(( POLL_RPS + BROWSE_RPS > 100 )) && log "NOTE: ≈ $((POLL_RPS + BROWSE_RPS)) req/s planned against the 100 req/s stage throttle: expect 429s (that's the point of PROFILE=peak)"

# --- 2. users and concert ----------------------------------------------------------------------------------------
NEED=$(( FAN_OFFSET + FANS ))
TOKENS="$STATE_DIR/tokens.json"
have=0; age=99999
if [[ -s "$TOKENS" ]]; then
  have="$(jq '.fans | length' "$TOKENS")"
  age=$(( $(epoch) - $(to_epoch "$(jq -r .createdAt "$TOKENS")") ))
fi
if (( have < NEED )); then
  log "creating $NEED test fans (about 1 s each)"
  "$LOADTEST_DIR/scripts/cognito-users.sh" create "$NEED"
  "$LOADTEST_DIR/scripts/cognito-users.sh" tokens
elif (( age > 2400 )); then
  log "tokens are $((age / 60)) min old (valid 60): refreshing"
  "$LOADTEST_DIR/scripts/cognito-users.sh" tokens
fi

log "creating the test concert ($SEATS seats, sale opens in ${SALE_OPENS_IN}s)"
(cd "$LOADTEST_DIR" && SEATS="$SEATS" SALE_OPENS_IN="$SALE_OPENS_IN" ADMIT_FANS=0 TITLE="Flash sale $TS" \
  k6 run -q k6/setup-concert.js >/dev/null)
CONCERT_ID="$(jq -r .concertId "$STATE_DIR/concert.json")"
[[ -n "$CONCERT_ID" && "$CONCERT_ID" != null ]] || die "setup-concert.js wrote no concert id"
export CONCERT_ID
log "concert $CONCERT_ID is on sale"

WATCH_PID=""
finish() {
  local rc=$?
  set +e # cleanup must run to the end even if a step fails
  [[ -n "$WATCH_PID" ]] && kill "$WATCH_PID" 2>/dev/null
  if [[ "$KEEP_CONCERT" != 1 ]]; then
    log "cancelling the test concert $CONCERT_ID (cancellation emails go to the SES simulator)"
    mutate curl -s -o /dev/null -w 'cancel: HTTP %{http_code}\n' -X POST \
      -H "Authorization: Bearer $(jq -r .organiser.accessToken "$TOKENS")" -H 'content-type: application/json' \
      -d '{"reason":"Flash-sale simulation finished"}' "$BASE_URL/api/organiser/concerts/$CONCERT_ID/cancel" >&2 || true
  fi
  if [[ "$CLEANUP" == 1 ]]; then "$LOADTEST_DIR/scripts/cognito-users.sh" cleanup >/dev/null || true; log "test users deleted"; fi
  exit "$rc"
}
trap finish EXIT

# --- 3. the sale -------------------------------------------------------------------------------------------------
"$LOADTEST_DIR/scripts/ecs-watch.sh" "$CSV" 15 &
WATCH_PID=$!

START="$(iso_now)"
log "sale simulation starts $START against $BASE_URL"
(cd "$LOADTEST_DIR" && k6 run --console-output "$FANLOG" --log-format raw k6/flash-sale.js) \
  || log "k6 exited non-zero (see its summary)"
END="$(iso_now)"
log "fans done at $END; waiting ${DRAIN_SEC}s for e-tickets and scale-in data"
sleep "$DRAIN_SEC"
kill "$WATCH_PID" 2>/dev/null || true; wait "$WATCH_PID" 2>/dev/null || true
DRAINED="$(iso_now)"

# --- 4. evidence -------------------------------------------------------------------------------------------------
latest() { ls -t "$RESULTS_DIR"/$1-*.json 2>/dev/null | head -1; }
K6_JSON="$(latest flash-sale-k6)"

SERVICE_KEY=organiser SERVICE="$NAME-organiser" "$LOADTEST_DIR/scripts/nfr3-oversell-check.sh" "$CONCERT_ID" >/dev/null 2>&1 \
  || log "oversell check reported a failure or did not run (see results/nfr3-oversell-sql-*)"
OVERSELL_JSON="$(latest nfr3-oversell-sql)"
"$LOADTEST_DIR/scripts/nfr7-eticket.sh" "$START" "$DRAINED" >/dev/null 2>&1 || true
ETICKET_JSON="$(latest nfr7-eticket)"

cw_max() { # namespace metric stat dims...
  local ns="$1" m="$2" st="$3"; shift 3
  local dims=(); (( $# > 0 )) && dims=(--dimensions "$@")
  aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$m" --start-time "$START" --end-time "$DRAINED" \
    --period 60 --statistics "$st" ${dims[@]+"${dims[@]}"} --output json |
    jq --arg st "$st" '[.Datapoints[][$st]] | if length == 0 then null elif $st == "Sum" then add else max end'
}
API_ID="$(aws apigatewayv2 get-apis --query "Items[?Name=='$HTTP_API_NAME'].ApiId | [0]" --output text)"
METRICS="$(jq -n \
  --argjson rdsConn "$(cw_max AWS/RDS DatabaseConnections Maximum Name=DBInstanceIdentifier,Value="$DB_INSTANCE")" \
  --argjson rdsCpu "$(cw_max AWS/RDS CPUUtilization Maximum Name=DBInstanceIdentifier,Value="$DB_INSTANCE")" \
  --argjson wr "$(cw_max TicketMastery WaitingRoomSize Maximum)" \
  --argjson gwCount "$(cw_max AWS/ApiGateway Count Sum Name=ApiId,Value="$API_ID")" \
  --argjson gw4xx "$(cw_max AWS/ApiGateway 4xx Sum Name=ApiId,Value="$API_ID")" \
  --argjson gw5xx "$(cw_max AWS/ApiGateway 5xx Sum Name=ApiId,Value="$API_ID")" \
  '{rdsMaxConnections: $rdsConn, rdsMaxCpuPercent: $rdsCpu, waitingRoomSizeMax: $wr, apiGatewayRequests: $gwCount,
    apiGateway4xx: $gw4xx, apiGateway5xx: $gw5xx}')"

ALARMS="$(aws cloudwatch describe-alarm-history --start-date "$START" --end-date "$DRAINED" --history-item-type StateUpdate \
  --max-items 200 --output json |
  jq '[.AlarmHistoryItems[] | select(.HistorySummary | test("to ALARM")) | {alarm: .AlarmName, at: .Timestamp}] | sort_by(.at)')"

# ecs-watch.sh columns 6+ are every API service's desired count, in SERVICE_KEYS order.
SCALING="$(tail -n +2 "$CSV" | { grep -v ',error' || true; } | jq -R -s --args '
  [split("\n")[] | select(length > 0) | split(",") | .[5:] | map(tonumber? // null)] as $rows
  | [$ARGS.positional | to_entries[] | .key as $i | {key: .value, value: {start: ($rows[0][$i]), max: ([$rows[][$i] | values] | max)}}]
  | from_entries' "${SERVICE_KEYS[@]}")"

# Per-fan outcomes and fairness. A fan admitted in a later batch than a fan behind them in the queue is an inversion;
# admit runs are a minute apart and fans poll every POLL_SEC, so "later batch" means more than 30 s later.
FANS_JSON="$({ grep '^FANRESULT ' "$FANLOG" || true; } | sed 's/^FANRESULT //' | jq -s '
  def pct(p): if length == 0 then null else sort | .[((length - 1) * p | floor)] end;
  def secs: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
  . as $all
  | ($all | map(select(.admittedAt != null and .position != null)) | sort_by(.position)) as $adm
  | ($adm | map(.admittedAt | secs)) as $t
  | (reduce range(($t | length) - 1; -1; -1) as $i ({min: null, out: []};
      .out = [.min] + .out | .min = (if .min == null or $t[$i] < .min then $t[$i] else .min end)) | .out) as $laterMin
  | {fans: length,
     outcomes: (group_by(.outcome) | map({key: .[0].outcome, value: length}) | from_entries),
     seatsBought: (map(.seats) | add),
     timeToAdmitSec: (map(.timeToAdmitSec | values) | {p50: pct(0.5), p95: pct(0.95), max: max}),
     timeToOrderSec: (map(.timeToOrderSec | values) | {p50: pct(0.5), p95: pct(0.95), max: max}),
     throttledPerFan: (map(.throttled) | {total: add, fansAffected: map(select(. > 0)) | length, max: max}),
     holdConflicts: (map(.conflicts) | add),
     fairnessInversions: ([range(0; $t | length) | select($laterMin[.] != null and $t[.] > $laterMin[.] + 30)] | length),
     firstSoldOutAt: (map(select(.outcome == "sold_out") | .finishedAt) | min),
     lastOrderAt: (map(select(.outcome == "bought") | .finishedAt) | max),
     errors: (map(select(.outcome == "error") | .reason) | group_by(.) | map({key: .[0], value: length}) | from_entries)}')"
SEATS_JSON="$({ grep -m1 '^SEATRESULT ' "$FANLOG" || echo 'SEATRESULT {}'; } | sed 's/^SEATRESULT //')"

jq -n --arg profile "$PROFILE" --arg concert "$CONCERT_ID" --arg start "$START" --arg end "$END" --arg drained "$DRAINED" \
  --arg ts "$TS" --arg batch "$BATCH" --arg ses "$SES_RATE" --arg maxconn "$MAXCONN" --arg backoff "$BACKOFF" \
  --argjson fans "$FANS_JSON" --argjson seats "$SEATS_JSON" --argjson metrics "$METRICS" --argjson alarms "$ALARMS" \
  --argjson scaling "$SCALING" \
  --argjson k6 "$( [[ -n "$K6_JSON" ]] && cat "$K6_JSON" || echo null)" \
  --argjson oversell "$( [[ -n "$OVERSELL_JSON" ]] && cat "$OVERSELL_JSON" || echo null)" \
  --argjson eticket "$( [[ -n "$ETICKET_JSON" ]] && cat "$ETICKET_JSON" || echo null)" \
  --argjson cfg "{\"fans\": $FANS, \"seats\": $SEATS, \"browseRps\": $BROWSE_RPS, \"arrivalSec\": $ARRIVAL_SEC, \"pollSec\": $POLL_SEC}" '
  {test: "flash-sale", ts: $ts, profile: $profile, concertId: $concert, start: $start, fansDone: $end, drained: $drained,
   config: ($cfg + {backoff: ($backoff == "1"), admitBatch: $batch, sesMaxSendRate: $ses, rdsMaxConnections: $maxconn}),
   fans: $fans, seatsAfter: $seats, k6: $k6, oversell: $oversell, eticket: $eticket, metrics: $metrics,
   scalingByService: $scaling, alarmsFired: $alarms}
  | .checks = {
      noOversell: (.oversell.pass // null),
      soldWithinCapacity: ((.seatsAfter.sold // 0) + (.seatsAfter.held // 0) <= (.seatsAfter.total // 0)),
      everyFanHasOutcome: (.fans.fans == .config.fans),
      fairAdmission: (.fans.fairnessInversions == 0),
      noServerErrors: ((.k6.serverErrors // 0) == 0),
      dbBelowMax: (if (.metrics.rdsMaxConnections == null or (.config.rdsMaxConnections | tonumber? ) == null) then null
                   else .metrics.rdsMaxConnections < (.config.rdsMaxConnections | tonumber) end)}
  | .pass = ([.checks[] | select(. == false)] | length == 0)' > "$RESULT_JSON"

jq -r '
  def cell: if . == null then "–" else tostring end;
  def ok: if . == true then "PASS" elif . == false then "FAIL" else "n/a" end;
  "# Flash-sale simulation, profile \(.profile) (\(.start) to \(.drained))\n",
  "Concert `\(.concertId)`: \(.config.seats) seats; \(.config.fans) fans arriving over \(.config.arrivalSec) s, polling every \(.config.pollSec) s (backoff on 429: \(.config.backoff)); anonymous browsing \(.config.browseRps) req/s. Admit batch \(.config.admitBatch)/min, SES \(.config.sesMaxSendRate) email/s, RDS max_connections \(.config.rdsMaxConnections).\n",
  "## Checks\n",
  "| Check | Result | Value |", "| --- | --- | --- |",
  "| No seat sold twice (SQL in the VPC) | \(.checks.noOversell | ok) | \(.oversell.seats_in_two_confirmed_orders | cell) seats in 2+ orders; \(.oversell.confirmed_orders | cell) orders |",
  "| Sold within capacity | \(.checks.soldWithinCapacity | ok) | sold \(.seatsAfter.sold | cell), held \(.seatsAfter.held | cell), free \(.seatsAfter.available | cell) of \(.seatsAfter.total | cell) |",
  "| Every fan has an outcome | \(.checks.everyFanHasOutcome | ok) | \(.fans.fans) of \(.config.fans) |",
  "| Fair admission | \(.checks.fairAdmission | ok) | \(.fans.fairnessInversions) fans admitted a batch after someone behind them |",
  "| No server errors (5xx) | \(.checks.noServerErrors | ok) | \(.k6.serverErrors | cell) (429s counted apart: \(.k6.throttled429 | cell)) |",
  "| DB connections below max | \(.checks.dbBelowMax | ok) | peak \(.metrics.rdsMaxConnections | cell) of \(.config.rdsMaxConnections) |",
  "\n**Overall: \(if .pass then "PASS" else "FAIL" end)**\n",
  "## Fans\n",
  "| Outcome | Fans |", "| --- | --- |",
  (.fans.outcomes | to_entries[] | "| \(.key) | \(.value) |"),
  "\nSeats bought: \(.fans.seatsBought | cell). Lost seat races (409): \(.fans.holdConflicts | cell). First fan to find it sold out: \(.fans.firstSoldOutAt | cell); last order: \(.fans.lastOrderAt | cell).\n",
  "| Seconds | p50 | p95 | max |", "| --- | --- | --- | --- |",
  "| arrival → admitted | \(.fans.timeToAdmitSec.p50 | cell) | \(.fans.timeToAdmitSec.p95 | cell) | \(.fans.timeToAdmitSec.max | cell) |",
  "| arrival → order confirmed | \(.fans.timeToOrderSec.p50 | cell) | \(.fans.timeToOrderSec.p95 | cell) | \(.fans.timeToOrderSec.max | cell) |",
  "\nThrottling: \(.fans.throttledPerFan.total | cell) fan requests got 429 (\(.fans.throttledPerFan.fansAffected | cell) fans, at most \(.fans.throttledPerFan.max | cell) each); API Gateway counted \(.metrics.apiGateway4xx | cell) 4xx and \(.metrics.apiGateway5xx | cell) 5xx of \(.metrics.apiGatewayRequests | cell) requests.\n",
  "p95 latency (ms): status \(.k6.p95Ms.status | cell), join \(.k6.p95Ms.join | cell), seat map \(.k6.p95Ms.seatMap | cell), hold \(.k6.p95Ms.hold | cell), pay \(.k6.p95Ms.confirm | cell).\n",
  "## Platform\n",
  "| Service | Tasks at start | Max tasks |", "| --- | --- | --- |",
  (.scalingByService | to_entries[] | "| \(.key) | \(.value.start | cell) | \(.value.max | cell) |"),
  "\nWaiting room peak: \(.metrics.waitingRoomSizeMax | cell) fans still waiting after an admit run (0 when one batch admits everyone). RDS: peak \(.metrics.rdsMaxConnections | cell) connections, CPU max \(.metrics.rdsMaxCpuPercent | if . then (. * 10 | round / 10) else . end | cell)%.\n",
  "E-tickets: \(.eticket.sent | cell) sent, p95 \(if .eticket.p95Ms then (.eticket.p95Ms / 1000 | round | tostring) + " s" else "–" end), \(.eticket.shareWithin60s | cell)% within 60 s (SES sends at most \(.config.sesMaxSendRate) email/s, so a big sale queues e-tickets).\n",
  "Alarms that went to ALARM: \(if (.alarmsFired | length) == 0 then "none" else (.alarmsFired | map("\(.alarm) (\(.at[11:19]) UTC)") | join(", ")) end).\n",
  "Files in results/: `flash-sale-\(.ts)-fans.log` (one line per fan), `flash-sale-\(.ts)-ecs.csv` (tasks every 15 s), and the k6, oversell-SQL and e-ticket results of the same run (`flash-sale-k6-*`, `nfr3-oversell-sql-*`, `nfr7-eticket-*`)."
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON, $RESULT_MD, $FANLOG and $CSV"

jq -e '.pass' "$RESULT_JSON" >/dev/null
