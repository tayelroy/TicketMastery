# CloudWatch alarms (live, 6 Nov 2026)

Read from the dev account with `aws cloudwatch describe-alarms --alarm-name-prefix ticketmastery-dev` after the
API was split into one ECS service per use case and the per-service alarms were trimmed. Defined in Terraform:
`infra/modules/monitoring/alarms.tf` (27 alarms) and `infra/modules/messaging` (`ticket-dlq-not-empty`).

**28 alarms in total.** Every alarm sends both its ALARM and OK transitions to SNS `ticketmastery-dev-alerts`,
which emails `tayelroy@gmail.com`.

| Group | Alarms |
|---|---|
| Per ECS service: service down + scaling ceiling × 5 services (discovery, account, waiting-room, checkout, organiser) | 10 |
| ECS CPU and memory, busiest service | 2 |
| API front door and ALB, whole API | 4 |
| Checkout business metric | 1 |
| Waiting room (UC3) | 2 |
| E-tickets (UC4/UC2) | 2 |
| Lambda errors and throttles | 4 |
| Database (RDS) | 3 |
| **Total** | **28** |

**Why 28 and not 41.** The first version of the split copied all five service alarms for every service (25, so 41
in total). Three of those copies carried no extra information:
- **Unhealthy hosts:** with one task per service it fires together with "no healthy hosts", and a partly failing
  service shows up in the 5xx alarms.
- **CPU and memory:** autoscaling already acts on CPU per service, and the scaling-ceiling alarm names a service
  that can't scale further.

They were replaced by one alarm each on the busiest service. Per service, only the two alarms that say which use case
is in trouble remain.

"Period × evaluations" is how long the condition must hold: for example, 60 s × 5 means 5 consecutive one-minute
datapoints. "Missing data" is how CloudWatch treats a minute with no datapoint.

## 1. ECS services (12 alarms)

Each service has its own target group and autoscaling policy, so "down" and "at its ceiling" are reported for the
affected service only. Per-service alarms are named `ticketmastery-dev-<service>-<alarm>`.

| Alarm | Metric (namespace) | Statistic | Condition | Period × evaluations | Missing data | What it means |
|---|---|---|---|---|---|---|
| `<service>-alb-no-healthy-hosts` (× 5) | `HealthyHostCount` (AWS/ApplicationELB, per target group) | Minimum | < 1 | 60 s × 2 | breaching | No healthy task: that part of the API is down. Missing data counts as down |
| `<service>-ecs-at-max-capacity` (× 5) | `LiveTaskCount` (AWS/ECS, per service) | Minimum | ≥ autoscaling max | 60 s × 5 | notBreaching | The service has been at its scaling ceiling for 5 minutes |
| `ecs-max-cpu-high` | Metric math: `MAX` of `CPUUtilization` (AWS/ECS) over the five services | Average | > 80% | 60 s × 5 | notBreaching | The busiest service is short of CPU even with autoscaling; the dashboard (one line per service) shows which |
| `ecs-max-memory-high` | Metric math: `MAX` of `MemoryUtilization` (AWS/ECS) over the five services | Average | > 80% | 60 s × 5 | notBreaching | Tasks of the busiest service risk being OOM-killed |

Autoscaling maximums, which are also the `at-max-capacity` thresholds:

| Service | Use case | Paths | Autoscaling max |
|---|---|---|---|
| discovery | UC1 | `/api/concerts*`, `/health` (default) | 3 |
| account | UC2 | `/api/me*` | 2 |
| waiting-room | UC3 | `/api/waiting-room/*` | 3 |
| checkout | UC4 | `/api/checkout/*` | 3 |
| organiser | UC5 | `/api/organiser/*` | 2 |

## 2. API front door and ALB, whole API (4 alarms)

| Alarm | Metric | Statistic | Condition | Period × evaluations | What it means |
|---|---|---|---|---|---|
| `alb-p95-latency` | `TargetResponseTime` (AWS/ApplicationELB) | p95 | > 0.3 s | 60 s × 3 | NFR-1: the API's p95 is above 300 ms |
| `alb-target-5xx-rate` | Metric math: `HTTPCode_Target_5XX_Count` / `RequestCount` | — | > 1% | 300 s × 1 | The API code returns 5xx for more than 1% of requests |
| `apigw-p95-latency` | `Latency` (AWS/ApiGateway) | p95 | > 500 ms | 60 s × 3 | Compared with the ALB p95, this separates gateway overhead from slow API code |
| `apigw-5xx-rate` | Metric math: `5xx` / `Count` (AWS/ApiGateway) | — | > 1% | 300 s × 1 | Also catches VPC link and "no healthy target" errors that the ALB alarm can't see |

The latency and 5xx alarms cover the whole API rather than each service, because NFR-1 and the error budget apply
to the API as a whole. The dashboard shows requests per service next to them.

## 3. Checkout business metric (1 alarm)

| Alarm | Metric | Condition | Period × evaluations | What it means |
|---|---|---|---|---|
| `checkout-failure-rate` | Metric math: `CheckoutPaymentFailures` / `CheckoutPaymentAttempts` (log metric filters on the API logs) | > 20% (at least 5 attempts) | 300 s × 1 | The payment gateway is likely down |

## 4. Waiting room, UC3 (2 alarms)

| Alarm | Metric | Statistic | Condition | Period × evaluations | What it means |
|---|---|---|---|---|---|
| `waiting-room-size` | `WaitingRoomSize` (TicketMastery, EMF from `queue-manager`) | Maximum | > 20,000 | 60 s × 1 | Very large queue; admins decide whether to raise the admit batch or the autoscaling max |
| `join-dlq-not-empty` | `ApproximateNumberOfMessagesVisible` (AWS/SQS, `join-queue-dlq.fifo`) | Maximum | > 0 | 300 s × 1 | Join requests failed repeatedly: those fans never got a queue position |

## 5. E-tickets, UC4/UC2 (2 alarms)

| Alarm | Metric | Statistic | Condition | Period × evaluations | What it means |
|---|---|---|---|---|---|
| `ticket-queue-oldest-message` | `ApproximateAgeOfOldestMessage` (AWS/SQS, `ticket-queue`) | Maximum | > 60 s | 60 s × 1 | NFR-7: e-tickets are not going out within a minute |
| `ticket-dlq-not-empty` | `ApproximateNumberOfMessagesVisible` (AWS/SQS, `ticket-dlq`) | Maximum | > 0 | 300 s × 1 | An e-ticket failed 5 times; re-drive after the fix (safe: sent orders are skipped) |

## 6. Lambda (4 alarms)

| Alarm | Metric (AWS/Lambda) | Statistic | Condition | Period × evaluations |
|---|---|---|---|---|
| `lambda-queue-manager-errors` | `Errors` | Sum | > 0 | 300 s × 1 |
| `lambda-queue-manager-throttles` | `Throttles` | Sum | > 0 | 300 s × 1 |
| `lambda-ticket-fn-errors` | `Errors` | Sum | > 0 | 300 s × 1 |
| `lambda-ticket-fn-throttles` | `Throttles` | Sum | > 0 | 300 s × 1 |

## 7. Database, RDS (3 alarms)

| Alarm | Metric (AWS/RDS) | Statistic | Condition | Period × evaluations | What it means |
|---|---|---|---|---|---|
| `rds-cpu-high` | `CPUUtilization` | Average | > 75% | 60 s × 5 | `db.t4g.micro` is burstable: check the CPU credit balance and slow queries |
| `rds-connections-high` | `DatabaseConnections` | Maximum | > 64 | 60 s × 5 | 80% of the estimated `max_connections` (80). Each API task holds up to 10 connections (`DB_POOL_MAX`) |
| `rds-free-storage-low` | `FreeStorageSpace` | Minimum | < 2 GiB | 300 s × 1 | Raise `db_allocated_storage` before writes fail |

`rds-connections-high` matters more after the split: 5 services at their autoscaling maximums (13 tasks) could
open up to 130 connections, above the estimated limit of 80.

## State when read

All 28 alarms were **OK**. Earlier the same day, with the untrimmed set, the browse burst
(`loadtest/results/nfr2-burst-aws-20261106T021055Z.md`) put `ticketmastery-dev-discovery-ecs-at-max-capacity` into
ALARM: discovery scaled from 1 to 3 tasks, its maximum, while account, waiting-room, checkout and organiser stayed at
1 task each. It returned to OK after discovery scaled back in.
