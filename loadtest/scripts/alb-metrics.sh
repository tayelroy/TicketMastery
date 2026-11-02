#!/usr/bin/env bash
# Server-side view of a load-test window from CloudWatch (read-only): ALB TargetResponseTime p95/p99, RequestCount,
# target and ALB 5xx, healthy targets, and ECS service CPU, per minute plus one overall row.
#
#   scripts/alb-metrics.sh <label> <start ISO-8601> <end ISO-8601>
#   e.g. scripts/alb-metrics.sh nfr1 2026-11-02T03:00:00Z 2026-11-02T03:06:00Z
# ALB metrics arrive within about a minute; run it a couple of minutes after the test ends.
source "$(dirname "$0")/lib.sh"

LABEL="${1:?usage: alb-metrics.sh <label> <start> <end>}"
START="${2:?start}"
END="${3:?end}"
require_aws

S="$(( $(to_epoch "$START") / 60 * 60 ))"
E="$(( ($(to_epoch "$END") + 59) / 60 * 60 ))"
WINDOW="$(( E - S ))"
LB="$(alb_dimension)"
TG="$(tg_dimension)"

queries() { # $1 = period
  jq -n --arg lb "$LB" --arg tg "$TG" --arg cluster "$CLUSTER" --arg service "$SERVICE" --argjson p "$1" '
    def q(id; ns; name; dims; stat): {Id: id, ReturnData: true,
      MetricStat: {Metric: {Namespace: ns, MetricName: name, Dimensions: dims}, Period: $p, Stat: stat}};
    [{Name: "LoadBalancer", Value: $lb}] as $alb
    | ($alb + [{Name: "TargetGroup", Value: $tg}]) as $albtg
    | [{Name: "ClusterName", Value: $cluster}, {Name: "ServiceName", Value: $service}] as $ecs
    | [ q("p95"; "AWS/ApplicationELB"; "TargetResponseTime"; $alb; "p95"),
        q("p99"; "AWS/ApplicationELB"; "TargetResponseTime"; $alb; "p99"),
        q("requests"; "AWS/ApplicationELB"; "RequestCount"; $alb; "Sum"),
        q("target5xx"; "AWS/ApplicationELB"; "HTTPCode_Target_5XX_Count"; $alb; "Sum"),
        q("elb5xx"; "AWS/ApplicationELB"; "HTTPCode_ELB_5XX_Count"; $alb; "Sum"),
        q("healthy"; "AWS/ApplicationELB"; "HealthyHostCount"; $albtg; "Maximum"),
        q("cpu"; "AWS/ECS"; "CPUUtilization"; $ecs; "Average") ]'
}

fetch() { # $1 = period
  aws cloudwatch get-metric-data --start-time "$(date -u -r "$S" +%FT%TZ 2>/dev/null || date -u -d "@$S" +%FT%TZ)" \
    --end-time "$(date -u -r "$E" +%FT%TZ 2>/dev/null || date -u -d "@$E" +%FT%TZ)" \
    --scan-by TimestampAscending --metric-data-queries "$(queries "$1")" --output json
}

# Rows keyed by timestamp: {time, p95Ms, p99Ms, requests, target5xx, elb5xx, healthy, cpu}
to_rows='
  [.MetricDataResults[] | . as $r | range(0; ($r.Timestamps | length)) | {t: $r.Timestamps[.], id: $r.Id, v: $r.Values[.]}]
  | group_by(.t)
  | map(reduce .[] as $x ({time: .[0].t}; .[$x.id] = $x.v))
  | map({time, p95Ms: ((.p95 // null) | if . then (. * 1000 | round) else null end),
         p99Ms: ((.p99 // null) | if . then (. * 1000 | round) else null end),
         requests: (.requests // 0), target5xx: (.target5xx // 0), elb5xx: (.elb5xx // 0),
         healthy: (.healthy // null), cpu: ((.cpu // null) | if . then (. * 10 | round / 10) else null end)})'

PER_MIN="$(fetch 60 | jq "$to_rows")"
OVERALL="$(fetch "$WINDOW" | jq "$to_rows | .[0] // {}")"

result_files "$LABEL-alb"
jq -n --arg label "$LABEL" --arg start "$START" --arg end "$END" --arg lb "$LB" \
  --argjson overall "$OVERALL" --argjson perMinute "$PER_MIN" \
  '{label: $label, start: $start, end: $end, loadBalancer: $lb, overall: $overall, perMinute: $perMinute}' > "$RESULT_JSON"

jq -r '
  def cell: if . == null then "" else tostring end;
  "# \(.label): ALB / ECS CloudWatch metrics (\(.start) to \(.end))\n",
  "Overall: TargetResponseTime p95 \(.overall.p95Ms | cell) ms, p99 \(.overall.p99Ms | cell) ms; \(.overall.requests | cell) requests; target 5xx \(.overall.target5xx | cell); ALB 5xx \(.overall.elb5xx | cell)\n",
  "| Minute (UTC) | Requests | ALB p95 ms | ALB p99 ms | Target 5xx | ALB 5xx | Healthy targets (max) | ECS CPU % |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  (.perMinute[] | "| \(.time) | \(.requests | cell) | \(.p95Ms | cell) | \(.p99Ms | cell) | \(.target5xx | cell) | \(.elb5xx | cell) | \(.healthy | cell) | \(.cpu | cell) |")
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON and .md"
