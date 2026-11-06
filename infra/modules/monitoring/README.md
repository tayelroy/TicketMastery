# monitoring

CloudWatch alarms, one dashboard, an SNS alert topic with an email subscription, and an AWS Budgets monthly cost
budget for the TicketMastery dev stack. It implements the proposal's "Monitoring and Alert Settings" table, adapted to
what is actually built: ECS Fargate services (one per use case) instead of EC2/Auto Scaling, and no ElastiCache.

**Status:** module written and validated (`terraform validate`; dashboard widgets checked with
`aws cloudwatch get-metric-widget-image`; log metric filter patterns checked with `aws logs test-metric-filter`).
Not yet wired into `envs/dev` or applied.

```
CloudWatch alarms ──alarm + OK──▶ SNS <name>-alerts ──▶ email (alert_email)
AWS Budgets (USD 20/40/60/80 actual, > USD 80 forecast) ──▶ email (alert_email)
CloudWatch dashboard <name>: alarm status + one graph per signal
```

| File | Contents |
|---|---|
| `main.tf` | SNS topic + email subscription, checkout-failure log metric filters, AWS Budgets budget |
| `alarms.tf` | every alarm |
| `dashboard.tf` | the dashboard |

## Alarms

Every alarm sends its `ALARM` and `OK` transitions to the `<name>-alerts` topic. "Period" is the evaluation window:
*N × 1 min* means N consecutive one-minute datapoints must all breach.

The API runs as one ECS service per use case (`ecs_services`: discovery, account, waiting-room, checkout,
organiser), each with its own target group. Rows marked **per service** exist once per service, named
`<name>-<service key>-<alarm>` (e.g. `ticketmastery-dev-checkout-ecs-cpu-high`), so an alert names the use case.
API latency and 5xx stay ALB-wide: NFR-1 and the error budget are for the API as a whole, and the dashboard shows
requests per service next to them.

| Signal | Metric | Alarm when | Period | Why |
|---|---|---|---|---|
| API latency | `AWS/ApplicationELB` `TargetResponseTime` p95 (LoadBalancer) | > 0.3 s | 3 × 1 min | NFR-1: browse and seat-map APIs p95 < 300 ms. Three minutes in a row filters out one slow cold request. |
| API errors | `HTTPCode_Target_5XX_Count` / `RequestCount` × 100 (metric math) | > 1 % | 5 min | A rate, not a count: a fixed count is noise at demo traffic and too late at on-sale traffic. No requests = no data = OK. |
| Task health (per service) | `UnHealthyHostCount` max (TargetGroup) | > 0 | 2 × 1 min | A task failing `/health` (it checks the DB) for two minutes is a real fault, not a deploy blip (the ALB needs 3 × 30 s failures to mark it). |
| Service down (per service) | `HealthyHostCount` min (TargetGroup) | < 1 | 2 × 1 min | With one task per service in implementation mode, zero healthy targets means that use case's requests get 503s. Missing data counts as breaching: the ALB always reports this metric. |
| ECS CPU (per service) | `AWS/ECS` `CPUUtilization` avg (ClusterName, ServiceName) | > 80 % | 5 × 1 min | Replaces the proposal's EC2 rows. Sustained, not spiky, CPU means that service's task count or size is too small. |
| ECS memory (per service) | `AWS/ECS` `MemoryUtilization` avg | > 80 % | 5 × 1 min | Node tasks near their memory limit get OOM-killed by ECS. |
| Scaling ceiling (per service) | `AWS/ECS` `LiveTaskCount` min | ≥ that service's `autoscaling_max_capacity` | 5 × 1 min | Replaces "ASG at max capacity". Only created when `autoscaling_enabled = true`: with a fixed task count the service is always at its maximum. |
| DB CPU | `AWS/RDS` `CPUUtilization` avg | > 75 % | 5 × 1 min | Proposal threshold. db.t4g.micro is burstable, so sustained load also drains CPU credits (on the dashboard). |
| DB connections | `AWS/RDS` `DatabaseConnections` max | > 64 (80 % of 80) | 5 × 1 min | 80 % of `max_connections`; see [max_connections](#rds-max_connections) for the 80. |
| DB storage | `AWS/RDS` `FreeStorageSpace` min | < 2 GiB | 5 min | 10 % of the 20 GiB volume: time to grow storage before writes fail. |
| Gateway errors | `AWS/ApiGateway` `5xx` / `Count` × 100 (ApiId) | > 1 % | 5 min | What fans see at the edge of the API, so it also catches VPC link and no-target errors that the ALB target alarm can't. |
| Gateway latency | `AWS/ApiGateway` `Latency` p95 (ApiId) | > 500 ms | 3 × 1 min | ALB budget (300 ms) plus the JWT authorizer and VPC link hop. The dashboard shows `IntegrationLatency` next to it to tell the two apart. |
| E-ticket backlog | `AWS/SQS` `ApproximateAgeOfOldestMessage` max (ticket-queue) | > 60 s | 1 min | E-tickets should arrive within seconds; a minute-old message means ticket-fn is failing or stopped. |
| Waiting-room DLQ | `AWS/SQS` `ApproximateNumberOfMessagesVisible` max (`join-queue-dlq.fifo`) | > 0 | 5 min | Each message is a fan whose join request never got a queue position. The ticket-dlq alarm lives in `modules/messaging` and uses this topic through its `alarm_actions`. |
| Lambda errors | `AWS/Lambda` `Errors` sum, per function (queue-manager, ticket-fn) | > 0 | 5 min | Any error in the waiting room or e-ticket pipeline needs a look; SQS retries hide them from fans until the DLQ fills. |
| Lambda throttles | `AWS/Lambda` `Throttles` sum, per function | > 0 | 5 min | Throttling delays positions and e-tickets; it means the account concurrency limit or a reserved concurrency is too low. |
| Waiting-room size | `TicketMastery` `WaitingRoomSize` max (custom, no dimensions) | > 20 000 | 1 min | Proposal threshold: notify, and admins decide whether to raise the admit rate or the API scaling maximum. queue-manager writes it every scheduled run as CloudWatch Embedded Metric Format (it has no NAT, so it can't call `PutMetricData`). No data outside a sale = OK. |
| Checkout failures | `TicketMastery` `CheckoutPaymentFailures` / `CheckoutPaymentAttempts` × 100 (log metric filters) | > 20 % with ≥ 5 attempts | 5 min | Proposal threshold: one in five payments failing means the payment provider is likely down. The 5-attempt floor stops a single declined card on a quiet day from alerting. |

With the 5 dev services: 15 shared alarms + 4 per service × 5 = 35 alarms in implementation mode, 40 with autoscaling
on (+1 scaling-ceiling alarm per service). Before the per-service split it was 19 (20).

### Proposal rows not carried over

| Proposal row | Why not |
|---|---|
| EC2 status checks | No EC2: Fargate replaces failed tasks itself; the target-health alarms cover the symptom. |
| ASG `GroupInServiceInstances` | No Auto Scaling group; replaced by the ECS `LiveTaskCount` scaling-ceiling alarm. |
| ElastiCache engine CPU / memory | No Redis in the built stack: seat holds are rows in PostgreSQL, covered by the RDS alarms. |
| Waiting room "every 10 s" | queue-manager runs every minute (EventBridge Scheduler minimum), so the metric is per minute. |

### Checkout failures: where the numbers come from

The API doesn't log a dedicated "payment declined" line, but pino-http writes one JSON line per request to the
API log group (`/ecs/ticketmastery-api`) with `req.method`, `req.url` and `res.statusCode`. The payment step is
`POST /api/checkout/holds/<id>/confirm`: `200` = paid, `402 payment_failed` = declined (the simulated failure,
`simulatePaymentFailure: true`). Two metric filters count them:

| Metric (`TicketMastery`) | Filter pattern |
|---|---|
| `CheckoutPaymentAttempts` | `{ $.req.method = "POST" && $.req.url = "/api/checkout/holds/*/confirm" && ($.res.statusCode = 200 \|\| $.res.statusCode = 402) }` |
| `CheckoutPaymentFailures` | `{ $.req.method = "POST" && $.req.url = "/api/checkout/holds/*/confirm" && $.res.statusCode = 402 }` |

Other statuses on that route (404, 409 hold expired or cancelled) never reached payment and count as neither. Both
patterns were checked against sample lines with `aws logs test-metric-filter`. If the confirm route or the logger's
field names change, update `local.confirm_request` in `main.tf`.

### RDS max_connections

RDS for PostgreSQL defaults `max_connections` to `LEAST({DBInstanceClassMemory/9531392}, 5000)`
([RDS quotas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html)). db.t4g.micro has 1 GiB
(1 073 741 824 bytes), so the formula gives at most 112. `DBInstanceClassMemory` is smaller than the instance's
memory because RDS reserves some for the OS and its own processes, so the real value is lower. The module therefore
uses `rds_max_connections = 80` (a conservative estimate) and alarms above `floor(0.8 × 80) = 64`. Check the real
value with `SHOW max_connections;` and set `rds_max_connections` to it. For scale: each API task opens at most
`DB_POOL_MAX = 10` connections, so the 5 services at one task each can use 50, and at their dev autoscaling maximums
(3 + 2 + 3 + 3 + 2 = 13 tasks) up to 130, above the estimated 80. The pools open connections on demand, so idle
services hold few, but before relying on autoscaling check `SHOW max_connections;` or lower `DB_POOL_MAX`.

## Dashboard

`<name>` (e.g. `ticketmastery-dev`): a header, an alarm-status panel with every alarm above, then 19 graphs (three per
row), each with its alarm threshold drawn as a horizontal line: ALB p95/p99 latency; ALB requests and 5xx rate; then
six per-service graphs with one line per ECS service (labelled by service key): ALB requests, healthy targets,
unhealthy targets, live tasks vs each service's autoscaling maximum, ECS CPU, ECS memory; then RDS CPU (with CPU
credits); RDS connections; RDS free storage; API Gateway requests and 5xx rate; API Gateway p95 latency and integration
latency; ticket-queue age and depth; e-ticket delivery latency (`TicketMastery/ETicketDeliveryLatency`, written by
ticket-fn); both DLQs; Lambda errors, throttles and invocations; waiting-room size; checkout payment failures. That is
57 metrics (30 of them the per-service lines). Before the split it was 16 graphs.

## AWS Budgets

`<name>-monthly-cost`: account-wide monthly cost budget of USD 80 (`budget_limit_usd`). Emails `alert_email` when
actual spend passes USD 20, 40, 60 and 80 (`budget_alert_thresholds_usd`, absolute values) and when the forecast for the
month passes USD 80. That is 5 notifications, the most AWS allows on one budget. Budget emails go straight to the
address and need no confirmation. Budgets data refreshes a few times a day, so these alerts lag actual spend by hours.

## Inputs

| Variable | Default | Source in `envs/dev` |
|---|---|---|
| `name` | required | `local.name` |
| `alert_email` | required | root variable `alert_email` |
| `alb_arn_suffix` | required | `module.ecs_service.alb_arn_suffix` |
| `ecs_cluster_name` | required | `module.ecs_service.cluster_name` |
| `ecs_services` | required | `{ for k, s in module.ecs_service.services : k => { service_name, target_group_arn_suffix, autoscaling_max_capacity } }` |
| `autoscaling_enabled` | `false` | `var.enable_autoscaling` |
| `rds_instance_id` | required | `module.rds.instance_id` |
| `rds_max_connections` | `80` | see above |
| `rds_free_storage_threshold_bytes` | `2147483648` (2 GiB) | |
| `http_api_id` | required | `module.auth_apigw.api_id` |
| `ticket_queue_name`, `ticket_dlq_name` | required | `module.messaging` |
| `join_dlq_name` | required | `module.waiting_room` (new output) |
| `lambda_function_names` | required | `{ queue-manager = module.waiting_room.queue_manager_function_name, ticket-fn = module.messaging.ticket_fn_function_name }` |
| `api_log_group_name` | required | `module.ecs_service.log_group_name` |
| `alb_p95_latency_seconds` | `0.3` | |
| `error_rate_percent` | `1` | ALB and API Gateway 5xx rate |
| `ecs_utilization_percent` | `80` | |
| `rds_cpu_percent` | `75` | |
| `apigw_p95_latency_ms` | `500` | |
| `ticket_queue_max_age_seconds` | `60` | |
| `waiting_room_size_threshold` | `20000` | |
| `checkout_failure_percent`, `checkout_failure_min_attempts` | `20`, `5` | |
| `budget_limit_usd` | `80` | |
| `budget_alert_thresholds_usd` | `[20, 40, 60, 80]` | at most 4 |
| `tags` | `{}` | |

`lambda_function_names` and `ecs_services` keys are fixed labels (they name the alarms, e.g.
`ticketmastery-dev-lambda-ticket-fn-errors`, `ticketmastery-dev-discovery-ecs-cpu-high`), so `for_each` never depends
on values only known after apply.

## Outputs

| Output | Use |
|---|---|
| `alerts_topic_arn` | `alarm_actions` for other modules' alarms (messaging `alarm_actions`) |
| `dashboard_name`, `dashboard_url` | open the dashboard |
| `alarm_names` | every alarm in this module, e.g. for `set-alarm-state` tests |
| `budget_name` | the Budgets budget |

## After apply

1. Open the "AWS Notification - Subscription Confirmation" email sent to `alert_email` and click **Confirm
   subscription**. Until then alarm emails are dropped (the subscription shows `PendingConfirmation`).
2. Force one alarm to prove the email path, then let it return to its real state on the next evaluation:

   ```bash
   aws cloudwatch set-alarm-state --alarm-name ticketmastery-dev-join-dlq-not-empty \
     --state-value ALARM --state-reason "Alert email test"
   ```

## Cost

All in ap-southeast-1, list prices, before the free tier:

| Item | Monthly |
|---|---|
| Alarms: 32 single-metric alarms (37 with autoscaling) + 3 metric-math alarms of 2 metrics each = 38 (43) alarm metrics × USD 0.10 | ~USD 3.80 (4.30) (10 alarm metrics free) |
| Custom metrics: `WaitingRoomSize`, `ETicketDeliveryLatency`, `CheckoutPaymentAttempts`, `CheckoutPaymentFailures` × USD 0.30 | ~USD 1.20 (10 free) |
| Dashboard | USD 3: 57 metrics is above the 50-metric limit of the free tier's 3 dashboards |
| SNS email, AWS Budgets (no budget actions) | free at this volume |
