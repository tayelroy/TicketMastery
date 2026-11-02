#!/usr/bin/env bash
# NFR-7: 95% of e-tickets emailed within 60 s of payment. Read-only evidence for a window (default the last hour):
#   - Logs Insights over the ticket-fn log group: "e-ticket sent" lines, deliveryLatencyMs p50/p95/max and the share
#     within 60 s (deliveryLatencyMs = SES accepted the email minus the order's confirmation time);
#   - SQS ticket-queue ApproximateAgeOfOldestMessage (max per minute), messages received, DLQ depth;
#   - SES Send / Delivery counts.
# Run it a few minutes after the purchases (k6/nfr3-oversell.js confirms orders, each one an OrderConfirmed event).
#
#   scripts/nfr7-eticket.sh [start ISO-8601] [end ISO-8601]
source "$(dirname "$0")/lib.sh"
require_aws

START="${1:-$(iso_ago 3600)}"
END="${2:-$(iso_now)}"
S="$(to_epoch "$START")"; E="$(to_epoch "$END")"
DLQ_NAME="${TICKET_DLQ_NAME:-$NAME-ticket-dlq}"

insights() { # $1 = query -> results as [{field: value}]
  local id status out
  id="$(aws logs start-query --log-group-name "$TICKET_FN_LOG_GROUP" --start-time "$S" --end-time "$E" \
    --query-string "$1" --query queryId --output text)" || die "Logs Insights query failed (does $TICKET_FN_LOG_GROUP exist?)"
  for _ in $(seq 1 60); do
    out="$(aws logs get-query-results --query-id "$id" --output json)"
    status="$(jq -r .status <<<"$out")"
    [[ "$status" == Complete ]] && break
    [[ "$status" == Failed || "$status" == Cancelled || "$status" == Timeout ]] && die "query $status"
    sleep 2
  done
  jq '[.results[] | map({key: .field, value: (.value | tonumber? // .)}) | from_entries]' <<<"$out"
}

LAT="$(insights 'filter msg = "e-ticket sent"
  | stats count(*) as sent, pct(deliveryLatencyMs, 50) as p50Ms, pct(deliveryLatencyMs, 95) as p95Ms, max(deliveryLatencyMs) as maxMs')"
WITHIN="$(insights 'filter msg = "e-ticket sent" and deliveryLatencyMs <= 60000 | stats count(*) as within60s')"
FAILED="$(insights 'filter level = "error" | stats count(*) as errors')"

metric() { # namespace name stat dims... -> max of per-minute datapoints (or sum when stat=Sum)
  local ns="$1" name="$2" stat="$3"; shift 3
  aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$name" --statistics "$stat" --period 60 \
    --start-time "$START" --end-time "$END" --dimensions "$@" --output json |
    jq --arg stat "$stat" '[.Datapoints[][$stat]] | if length == 0 then null elif $stat == "Sum" then add else max end'
}
metric_nodim() {
  aws cloudwatch get-metric-statistics --namespace "$1" --metric-name "$2" --statistics Sum --period 60 \
    --start-time "$START" --end-time "$END" --output json | jq '[.Datapoints[].Sum] | if length == 0 then null else add end'
}

AGE_MAX="$(metric AWS/SQS ApproximateAgeOfOldestMessage Maximum Name=QueueName,Value="$TICKET_QUEUE_NAME")"
RECEIVED="$(metric AWS/SQS NumberOfMessagesSent Sum Name=QueueName,Value="$TICKET_QUEUE_NAME")"
DLQ_MAX="$(metric AWS/SQS ApproximateNumberOfMessagesVisible Maximum Name=QueueName,Value="$DLQ_NAME")"
SES_SEND="$(metric_nodim AWS/SES Send)"
SES_DELIVERY="$(metric_nodim AWS/SES Delivery)"

result_files nfr7-eticket
jq -n --arg start "$START" --arg end "$END" --arg lg "$TICKET_FN_LOG_GROUP" --arg queue "$TICKET_QUEUE_NAME" \
  --argjson lat "$LAT" --argjson within "$WITHIN" --argjson failed "$FAILED" \
  --argjson age "$AGE_MAX" --argjson received "$RECEIVED" --argjson dlq "$DLQ_MAX" \
  --argjson sesSend "$SES_SEND" --argjson sesDelivery "$SES_DELIVERY" '
  ($lat[0] // {sent: 0}) as $l
  | {test: "nfr7-eticket", start: $start, end: $end, logGroup: $lg, queue: $queue,
     sent: ($l.sent // 0), p50Ms: $l.p50Ms, p95Ms: $l.p95Ms, maxMs: $l.maxMs,
     within60s: ($within[0].within60s // 0), ticketFnErrorLines: ($failed[0].errors // 0),
     maxAgeOfOldestMessageSec: $age, messagesIntoTicketQueue: $received, dlqMaxVisible: $dlq,
     sesSend: $sesSend, sesDelivery: $sesDelivery}
  | .shareWithin60s = (if .sent > 0 then (.within60s / .sent * 1000 | round / 10) else null end)
  | .pass = (.sent > 0 and .shareWithin60s >= 95)' > "$RESULT_JSON"

jq -r '
  def cell: if . == null then "" else tostring end;
  def s: if . == null then "" else (. / 1000 * 10 | round / 10 | tostring) end;
  "# nfr7-eticket (\(.start) to \(.end))\n",
  "| E-tickets sent | p50 s | p95 s | Max s | Within 60 s | Max SQS age of oldest message (s) | Messages into ticket-queue | DLQ max | SES send / delivery | NFR-7 (≥ 95% in 60 s) |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| \(.sent) | \(.p50Ms | s) | \(.p95Ms | s) | \(.maxMs | s) | \(.within60s) (\(.shareWithin60s | cell)%) | \(.maxAgeOfOldestMessageSec | cell) | \(.messagesIntoTicketQueue | cell) | \(.dlqMaxVisible | cell) | \(.sesSend | cell) / \(.sesDelivery | cell) | \(if .pass then "PASS" else "FAIL" end) |\n",
  "Latency = SES accepted the email minus the order confirmation time (ticket-fn `deliveryLatencyMs`, log group `\(.logGroup)`); ticket-fn error lines in the window: \(.ticketFnErrorLines)."
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON and .md"
