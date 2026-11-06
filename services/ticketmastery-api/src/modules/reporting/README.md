# reporting module — UC5 internal reporting

**Owner:** Elroy
**Mounted at:** `/api/reports` — every route requires `authenticate` + `requireGroup('organisers')`.
**Runs as:** its own ECS service, `reporting` (`API_MODULES=reporting`), connected to RDS as the read-only role
`reporting_ro` (migration `0004`), not the master user. See [docs/reporting.md](../../../../../docs/reporting.md).

| Method & path | Purpose |
|---|---|
| `GET /sales?days=7\|30\|90\|all&concertId=` | Sales report for my concerts (or one): totals, by concert, by day, by ticket type, seat status, recent orders (`Cache-Control: no-store`) |

## Rules

- **Views only.** `reporting_ro` can `SELECT` the five `report_*` views (`migrations/0003_uc5_reporting_views.sql`)
  and nothing else: no table, not even `concerts`. Every query in `repository.ts` therefore reads only those views;
  concert details come from `report_sales_by_concert` (title, artist, venue, start, status of concerts with sales)
  and `report_seat_status` (title, start, status and organiser of every concert, drafts included). A new query that
  touches a table works locally as the migration owner but fails in AWS with `permission denied`;
  `test/reporting.test.ts` runs every repository function under `SET LOCAL ROLE reporting_ro` to catch that.
- **Only my concerts.** Every query is filtered on `organiser_id = <caller's sub>`. With `concertId` the concert must
  be the caller's: `report_seat_status` gives its organiser, `404 not_found` if there is no such concert, `403
  forbidden` if it is someone else's (same codes and messages as the organiser module).
- **Sales** are confirmed orders only; money is integer cents per currency, never added across currencies.
- **Range.** `days` (default `30`) selects Singapore calendar days: `to` is today in Singapore, `from` is `days - 1`
  days earlier, filtered on `sale_date_sgt`; `all` gives `from: null` (since the first sale). In the range: `totals`
  (with `averageOrderCents` = gross / orders, rounded), `byConcert` (gross descending; cancelled concerts keep their
  sales, tagged by `status`), `byDay` (every day from `from`, or the first sale, to `to`, zero-filled, per currency
  with sales in the range) and `recentOrders` (newest 50, no fan identity). Not in the range: `byTicketType` is **all
  time** (the view has no date) and `seatStatus` is the current available/held/sold/total of every concert, drafts
  included.
- **Live.** Plain views, queried on every request (no cache, no precomputed tables). The six section queries run in
  parallel on the pool, no transaction. In AWS the pool is `DB_POOL_MAX=4` per task (2 tasks at most), within the
  role's `CONNECTION LIMIT 10`.
- `/health` (`src/health.ts`) runs `SELECT 1`, which `reporting_ro` may run, so the ALB health check works with
  this login. The service never runs migrations (`RUN_MIGRATIONS_ON_START=false`): the role can't create tables.

## Code

- `router.ts`: HTTP + zod parsing only.
- `service.ts`: ownership check, Singapore date range (`reportRange`), row-to-JSON mapping.
- `repository.ts`: SQL, all over the `report_*` views.
- `schemas.ts`: zod query schema.

Tests: `test/reporting.test.ts` (against Postgres, skipped without `DB_HOST`; the `reporting_ro` test needs a superuser
connection, as in docker-compose, to `SET ROLE`).
