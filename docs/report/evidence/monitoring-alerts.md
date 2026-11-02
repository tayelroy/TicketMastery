# Monitoring: alarms that fired, and alert delivery

Source: `aws cloudwatch describe-alarm-history` (state updates and actions) and the `AWS/SNS`
`NumberOfNotificationsDelivered` / `NumberOfNotificationsFailed` metrics for `ticketmastery-dev-alerts`, read
2026-11-01. Times in UTC. The SNS email subscription was confirmed between the burst runs (03:xx) and the F1 drill
(09:26): the burst alarms published to SNS but had no confirmed subscriber yet, so only the F1 and forced-test
notifications reached the inbox.

## Real alarms during the NFR-2 burst, run 1 (one task)

| Time | Alarm | Change |
| --- | --- | --- |
| 03:09:02 | `ticketmastery-dev-apigw-5xx-rate` | OK → ALARM |
| 03:10:21 | `ticketmastery-dev-apigw-p95-latency` | OK → ALARM |
| 03:11:49 | `ticketmastery-dev-alb-target-5xx-rate` | OK → ALARM |
| 03:12:55 | `ticketmastery-dev-alb-p95-latency` | OK → ALARM |
| 03:13:21 | `ticketmastery-dev-apigw-p95-latency` | ALARM → OK |
| 03:15:02 | `ticketmastery-dev-apigw-5xx-rate` | ALARM → OK |
| 03:15:55 | `ticketmastery-dev-alb-p95-latency` | ALARM → OK |
| 03:17:49 | `ticketmastery-dev-alb-target-5xx-rate` | ALARM → OK |
| 03:18:46 | `ticketmastery-dev-ecs-at-max-capacity` | OK → ALARM (3 of 3 tasks for 5 min) |
| 03:25:45 | `ticketmastery-dev-ecs-at-max-capacity` | ALARM → OK (run 2 raised the maximum to 4) |
| 03:40:45 | `ticketmastery-dev-ecs-at-max-capacity` | OK → ALARM (4 of 4 tasks for 5 min, run 2) |
| 04:01:45 | `ticketmastery-dev-ecs-at-max-capacity` | ALARM → OK |

The first error alarm (API Gateway 5xx rate) fired 2 min 40 s after the burst's ramp started and about 1 minute after
the first failed requests; the latency alarms need three one-minute datapoints, so they follow 1–2 minutes later.
Every ALARM and OK transition published to the SNS topic.

## Drill F1 (task stopped, 09:26:56)

| Time | Alarm | Change |
| --- | --- | --- |
| 09:28:02 | `ticketmastery-dev-apigw-5xx-rate` | OK → ALARM (503s while no task was healthy) |

## Forced end-to-end test

`aws cloudwatch set-alarm-state --alarm-name ticketmastery-dev-join-dlq-not-empty --state-value ALARM` at
09:29:53. Alarm history: action `Successfully executed action arn:aws:sns:…:ticketmastery-dev-alerts` at 09:29:54; the
alarm re-evaluated to OK at 09:30:40 (the DLQ is empty), which sent the OK email.
`NumberOfNotificationsDelivered` for the topic: 1 per minute at 09:28, 09:29 and 09:30 (the F1 alarm, the forced
ALARM, the OK); `NumberOfNotificationsFailed`: 0.
