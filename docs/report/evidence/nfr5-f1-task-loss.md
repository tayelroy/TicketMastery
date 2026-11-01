# nfr5-f1: lose the API task (2026-11-01T09:26:56Z)

| Tasks before | First failed /health (s after stop) | /health 200 again (s after stop) | Outage (s) | Failed probes (every 1 s) | RTO ≤ 5 min |
| --- | --- | --- | --- | --- | --- |
| 1 | 8 | 84 | 76 | 72 | PASS |

Stopped `arn:aws:ecs:ap-southeast-1:000246635159:task/ticketmastery-dev-cluster/52e81e8e9840400c84fa23838902404d`; replacement `arn:aws:ecs:ap-southeast-1:000246635159:task/ticketmastery-dev-cluster/a9493f8aa3b74f258ec79864ffea18f6`. Probe log: /Users/tayelroy/Coding/TicketMastery/loadtest/results/nfr5-f1-20261101T092656Z.csv

- 2026-11-01T09:27:01.967000+00:00: (service ticketmastery-dev-api) deregistered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T09:27:01.999000+00:00: (service ticketmastery-dev-api, taskSet ecs-svc/4549428710736324699) has begun draining connections on 1 tasks.
- 2026-11-01T09:27:50.524000+00:00: (service ticketmastery-dev-api) has started 1 tasks: (task a9493f8aa3b74f258ec79864ffea18f6).
- 2026-11-01T09:28:18.330000+00:00: (service ticketmastery-dev-api) registered 1 targets in (target-group arn:aws:elasticloadbalancing:ap-southeast-1:000246635159:targetgroup/ticketmastery-dev-api-tg/69e7d1814340733c)
- 2026-11-01T09:28:27.783000+00:00: (service ticketmastery-dev-api) has reached a steady state.
