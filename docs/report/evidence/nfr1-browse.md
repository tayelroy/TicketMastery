# nfr1-browse (2026-11-01T02:57:04.905Z to 2026-11-01T03:02:04.988Z)

Target: `https://veft7waoye.execute-api.ap-southeast-1.amazonaws.com` (AUTH=cognito)

| Load | Requests | p50 ms | p95 ms | p99 ms | Max ms | Errors | NFR-1 (p95 < 300, p99 < 800) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 req/s for 5m | 3000 | 11 | 30.3 | 43.3 | 339.4 | 0% | PASS |

| Endpoint | Requests | p95 ms | p99 ms |
| --- | --- | --- | --- |
| GET /api/concerts | 900 | 13.8 | 23.6 |
| GET /api/concerts/:id | 1195 | 14.7 | 31.5 |
| GET /api/concerts/:id/seats | 905 | 35.3 | 52.9 |

# nfr1: ALB / ECS CloudWatch metrics (2026-11-01T02:57:04Z to 2026-11-01T03:02:05Z)

Overall: TargetResponseTime p95 11 ms, p99 20 ms; 3001.0 requests; target 5xx 0; ALB 5xx 0

| Minute (UTC) | Requests | ALB p95 ms | ALB p99 ms | Target 5xx | ALB 5xx | Healthy targets (max) | ECS CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-01T02:57:00+00:00 | 551.0 | 11 | 14 | 0 | 0 | 1.0 | 10.9 |
| 2026-11-01T02:58:00+00:00 | 600.0 | 11 | 15 | 0 | 0 | 1.0 | 13.5 |
| 2026-11-01T02:59:00+00:00 | 600.0 | 11 | 15 | 0 | 0 | 1.0 | 14.5 |
| 2026-11-01T03:00:00+00:00 | 600.0 | 12 | 76 | 0 | 0 | 1.0 | 15.4 |
| 2026-11-01T03:01:00+00:00 | 600.0 | 11 | 20 | 0 | 0 | 1.0 | 12 |
| 2026-11-01T03:02:00+00:00 | 50.0 | 14 | 30 | 0 | 0 | 1.0 |  |
