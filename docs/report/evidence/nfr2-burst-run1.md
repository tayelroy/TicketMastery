# nfr2-burst (2026-11-01T03:04:21.098Z to 2026-11-01T03:21:21.199Z)

Target: `https://veft7waoye.execute-api.ap-southeast-1.amazonaws.com` (AUTH=cognito)

| Base → peak | Requests | Peak minute req/s | p95 ms | p99 ms | 429 (throttled) | Dropped (non-429 errors) | NFR-2 dropped = 0 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 → 100 req/s | 64964 | 100 | 9572.3 | 18688.8 | 0 | 2153 | FAIL |

| Phase | Seconds | Requests | req/s | p95 ms | 429 | Dropped |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | 120 | 1199 | 10 | 32.8 | 0 | 0 |
| ramp-up | 60 | 3213 | 53.5 | 2226 | 0 | 0 |
| peak | 600 | 55448 | 92.4 | 9690.1 | 0 | 2153 |
| ramp-down | 60 | 3302 | 55 | 27.5 | 0 | 0 |
| cooldown | 180 | 1801 | 10 | 30.5 | 0 | 0 |

Per minute (merge with the ECS task count from scripts/nfr2-burst.sh):

| Minute | From (UTC) | Requests | req/s | p95 ms | 429 | Dropped |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-11-01T03:04:21.102Z | 599 | 10 | 34.3 | 0 | 0 |
| 1 | 2026-11-01T03:05:21.102Z | 600 | 10 | 30.1 | 0 | 0 |
| 2 | 2026-11-01T03:06:21.102Z | 3213 | 53.5 | 2226 | 0 | 0 |
| 3 | 2026-11-01T03:07:21.102Z | 4063 | 67.7 | 24844.7 | 0 | 878 |
| 4 | 2026-11-01T03:08:21.102Z | 4927 | 82.1 | 19403.4 | 0 | 1053 |
| 5 | 2026-11-01T03:09:21.102Z | 4615 | 76.9 | 9948 | 0 | 222 |
| 6 | 2026-11-01T03:10:21.102Z | 5844 | 97.4 | 12178.5 | 0 | 0 |
| 7 | 2026-11-01T03:11:21.102Z | 5999 | 100 | 1503.5 | 0 | 0 |
| 8 | 2026-11-01T03:12:21.102Z | 6000 | 100 | 28 | 0 | 0 |
| 9 | 2026-11-01T03:13:21.102Z | 6000 | 100 | 27.6 | 0 | 0 |
| 10 | 2026-11-01T03:14:21.102Z | 6000 | 100 | 28.7 | 0 | 0 |
| 11 | 2026-11-01T03:15:21.102Z | 6000 | 100 | 28.7 | 0 | 0 |
| 12 | 2026-11-01T03:16:21.102Z | 6000 | 100 | 28.2 | 0 | 0 |
| 13 | 2026-11-01T03:17:21.102Z | 3302 | 55 | 27.5 | 0 | 0 |
| 14 | 2026-11-01T03:18:21.102Z | 600 | 10 | 29.7 | 0 | 0 |
| 15 | 2026-11-01T03:19:21.102Z | 600 | 10 | 30.6 | 0 | 0 |
| 16 | 2026-11-01T03:20:21.102Z | 601 | 10 | 31.4 | 0 | 0 |


# nfr2-burst: ECS scaling (2026-11-01T03:04:20Z to 2026-11-01T03:21:21Z)

| Tasks before | Max tasks | Scale-out decided (min after ramp start) | Max tasks running (min after ramp start) | Scale-out ≤ 5 min |
| --- | --- | --- | --- | --- |
| 1 | 3 | 3.9 | 4.2 | PASS |

Task count over time (every 15 s):


Scaling activities:

- 2026-11-01T03:10:05.110000+00:00 Successful: Setting desired count to 3.

ECS service events:

- 2026-11-01T03:08:35.227000+00:00: (service ticketmastery-dev-api) has started 1 tasks: (task 4cca8c3badc7472ca2434f1b552b503c). Amazon ECS replaced 1 tasks due to an unhealthy status.
- 2026-11-01T03:09:03.792000+00:00: (service ticketmastery-dev-api) registered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:09:13.395000+00:00: (service ticketmastery-dev-api) (task beebd12c224e4a55add5760b349e94b3) (port 3000) is unhealthy in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c) due to (reason Health checks failed with these codes: [503]).
- 2026-11-01T03:09:13.420000+00:00: (service ticketmastery-dev-api) has stopped 1 running tasks: (task beebd12c224e4a55add5760b349e94b3).
- 2026-11-01T03:09:22.197000+00:00: (service ticketmastery-dev-api) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:09:22.201000+00:00: (service ticketmastery-dev-api, taskSet ecs-svc/4549428710736324699) has begun draining connections on 1 tasks.
- 2026-11-01T03:09:22.250000+00:00: (service ticketmastery-dev-api) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:09:31.688000+00:00: (service ticketmastery-dev-api) has reached a steady state.
- 2026-11-01T03:10:06.298000+00:00: (service ticketmastery-dev-api) has started 2 tasks: (task 6e7ff3c6c86643b49dcc93bc26739bdc) (task 8a36d91d733a448f9dbf4bb6f7d3957d).
- 2026-11-01T03:10:24.873000+00:00: (service ticketmastery-dev-api) registered 2 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:10:44.596000+00:00: (service ticketmastery-dev-api) has started 1 tasks: (task c74f554b5b6148deb95343dc034ab8e5). Amazon ECS replaced 1 tasks due to an unhealthy status.
- 2026-11-01T03:11:12.333000+00:00: (service ticketmastery-dev-api) registered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:11:21.433000+00:00: (service ticketmastery-dev-api) (task 4cca8c3badc7472ca2434f1b552b503c) (port 3000) is unhealthy in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c) due to (reason Health checks failed with these codes: [503]).
- 2026-11-01T03:11:21.459000+00:00: (service ticketmastery-dev-api) has stopped 1 running tasks: (task 4cca8c3badc7472ca2434f1b552b503c).
- 2026-11-01T03:11:30.848000+00:00: (service ticketmastery-dev-api) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:11:30.853000+00:00: (service ticketmastery-dev-api, taskSet ecs-svc/4549428710736324699) has begun draining connections on 1 tasks.
- 2026-11-01T03:11:30.921000+00:00: (service ticketmastery-dev-api) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T03:11:40.330000+00:00: (service ticketmastery-dev-api) has reached a steady state.

# nfr2: ALB / ECS CloudWatch metrics (2026-11-01T03:04:20Z to 2026-11-01T03:21:21Z)

Overall: TargetResponseTime p95 9476 ms, p99 18677 ms; 64964.0 requests; target 5xx 1991.0; ALB 5xx 0

| Minute (UTC) | Requests | ALB p95 ms | ALB p99 ms | Target 5xx | ALB 5xx | Healthy targets (max) | ECS CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-01T03:04:00+00:00 | 389.0 | 11 | 13 | 0 | 0 | 1.0 | 8 |
| 2026-11-01T03:05:00+00:00 | 600.0 | 11 | 21 | 0 | 0 | 1.0 | 12.7 |
| 2026-11-01T03:06:00+00:00 | 1733.0 | 71 | 215 | 0 | 0 | 1.0 | 27.3 |
| 2026-11-01T03:07:00+00:00 | 3616.0 | 15597 | 24860 | 0 | 0 | 1.0 | 93.6 |
| 2026-11-01T03:08:00+00:00 | 4567.0 | 10798 | 32967 | 1528.0 | 0 | 0.0 | 49.6 |
| 2026-11-01T03:09:00+00:00 | 4756.0 | 23364 | 32028 | 345.0 | 0 | 1.0 | 58.6 |
| 2026-11-01T03:10:00+00:00 | 5596.0 | 9209 | 10065 | 118.0 | 0 | 2.0 | 28.6 |
| 2026-11-01T03:11:00+00:00 | 6492.0 | 11561 | 14048 | 0 | 0 | 3.0 | 40.1 |
| 2026-11-01T03:12:00+00:00 | 6000.0 | 12 | 79 | 0 | 0 | 3.0 | 28.6 |
| 2026-11-01T03:13:00+00:00 | 5999.0 | 11 | 66 | 0 | 0 | 3.0 | 35.4 |
| 2026-11-01T03:14:00+00:00 | 6001.0 | 11 | 72 | 0 | 0 | 3.0 | 33.5 |
| 2026-11-01T03:15:00+00:00 | 6000.0 | 11 | 73 | 0 | 0 | 3.0 | 34.6 |
| 2026-11-01T03:16:00+00:00 | 6000.0 | 11 | 79 | 0 | 0 | 3.0 | 34.5 |
| 2026-11-01T03:17:00+00:00 | 4868.0 | 11 | 58 | 0 | 0 | 3.0 | 32 |
| 2026-11-01T03:18:00+00:00 | 935.0 | 12 | 81 | 0 | 0 | 3.0 | 11.9 |
| 2026-11-01T03:19:00+00:00 | 600.0 | 11 | 13 | 0 | 0 | 3.0 | 4.6 |
| 2026-11-01T03:20:00+00:00 | 600.0 | 11 | 21 | 0 | 0 | 3.0 | 5.1 |
| 2026-11-01T03:21:00+00:00 | 212.0 | 12 | 15 | 0 | 0 | 3.0 | 3.1 |
