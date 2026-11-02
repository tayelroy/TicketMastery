# Load-test results

Every script writes `<test>-<UTC timestamp>.json` (full numbers) and `.md` (a table to paste into
`docs/report/report.md` section 10) here. Some also write a `.csv` timeline (ECS task count, `/health` probes).
The files are gitignored: copy the numbers into the report and keep any screenshots in `docs/report/evidence/`.

| File prefix | Written by | Report slot |
|---|---|---|
| `setup-concert-` | `k6/setup-concert.js` | (concert id used by the tests) |
| `nfr1-browse-`, `nfr1-alb-` | `k6/nfr1-browse.js`, `scripts/alb-metrics.sh nfr1 …` | NFR-1 k6 p95/p99, ALB `TargetResponseTime` p95 |
| `nfr2-burst-`, `nfr2-burst-aws-`, `nfr2-alb-` | `scripts/nfr2-burst.sh` | NFR-2 peak rps, tasks 1 → N, scale-out time, non-429 errors |
| `nfr3-oversell-`, `nfr3-oversell-sql-` | `k6/nfr3-oversell.js`, `scripts/nfr3-oversell-check.sh` | NFR-3 hold attempts, successful holds, oversold seats |
| `nfr4-hold-expiry-` | `k6/nfr4-hold-expiry.js` | NFR-4 seconds after expiry |
| `nfr5-f1-` | `scripts/nfr5-f1-task-loss.sh` | NFR-5 / F1 seconds until `/health` is 200 |
| `nfr6-waiting-room-` | `k6/nfr6-waiting-room.js` | NFR-6 N and order mismatches |
| `nfr7-eticket-` | `scripts/nfr7-eticket.sh` | NFR-7 max SQS age, p95 payment-to-send |
| `nfr8-f4-pitr-` | `scripts/nfr8-f4-pitr.sh` | NFR-8/9 restore point, restore duration |
| `nfr10-config-` | `scripts/nfr10-config.sh` | NFR-10 configuration review |

Results from a local dry run say `Target: http://localhost:…` in their heading; only the AWS runs are evidence.
