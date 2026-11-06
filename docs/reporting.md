# UC5 internal reporting

Answers [instructor feedback e](architecture.md#instructor-feedback-and-how-we-addressed-it): organisers need
internal reporting and sales statistics, for example in QuickSight.

- **Data layer:** five read-only SQL views in RDS
  ([`0003_uc5_reporting_views.sql`](../services/ticketmastery-api/migrations/0003_uc5_reporting_views.sql)), applied
  by the API's migration runner like every other migration, and checked row by row in
  [`test/reporting-views.test.ts`](../services/ticketmastery-api/test/reporting-views.test.ts) against orders made
  through the real organiser and checkout services.
- **Reports page:** `/organiser/reports` in the web app, backed by `GET /api/organiser/reports/sales` in the existing
  organiser module (UC5 ECS service). It reads the five views, only ever for the signed-in organiser's concerts.
  No extra AWS resources: same service, same RDS, same Cognito group check.
- **QuickSight:** designed, not deployed (see [QuickSight](#quicksight)).

The live organiser dashboard (`GET /api/organiser/concerts/:id/dashboard`, polled every 5 s) stays the tool for
the on-sale moment. The reports are for after-the-fact questions across concerts: how much did we sell, of what,
on which day.

## Reporting views

All views are plain (not materialised) views in the API's schema, so they are always current and need no refresh
job. Conventions shared by every view:

- **Sales = confirmed orders.** Pending, cancelled (released or payment declined) and expired checkout attempts
  are not sales.
- **Money is integer cents, as `bigint`, per currency.** An order has one currency, but a concert can have ticket
  types in different currencies, so every sales view groups by `currency` and never adds across currencies.
- **`organiser_id`** (the organiser's Cognito `sub`) is on every view; the Reports API filters every query on it.
- **Cancelled concerts keep their sales** (no refunds exist yet). Filter on `concert_status` to leave them out.
- **No buyer identities.** `fan_id` is not exposed; reporting doesn't need it.

| View | One row per | Columns |
|---|---|---|
| `report_confirmed_orders` | confirmed order | `order_id`, `concert_id`, `organiser_id`, `currency`, `seats`, `ticket_revenue_cents`, `booking_fee_cents`, `gross_revenue_cents`, `confirmed_at`, `sale_date_sgt` |
| `report_sales_by_concert` | concert × currency | `concert_id`, `organiser_id`, `concert_title`, `artist`, `venue_name`, `concert_starts_at`, `concert_status`, `currency`, `confirmed_orders`, `seats_sold`, `ticket_revenue_cents`, `booking_fee_cents`, `gross_revenue_cents` |
| `report_sales_by_ticket_type` | concert × ticket type × currency | `concert_id`, `organiser_id`, `concert_title`, `ticket_type_id`, `ticket_type_name`, `ticket_type_sort_order`, `currency`, `confirmed_orders`, `seats_sold`, `ticket_revenue_cents` |
| `report_sales_by_day` | Singapore day × concert × currency | `sale_date`, `concert_id`, `organiser_id`, `concert_title`, `currency`, `confirmed_orders`, `seats_sold`, `ticket_revenue_cents`, `booking_fee_cents`, `gross_revenue_cents` |
| `report_seat_status` | concert (every concert, drafts included) | `concert_id`, `organiser_id`, `concert_title`, `concert_starts_at`, `concert_status`, `available`, `held`, `sold`, `total` |

Definitions:

- `ticket_revenue_cents`: face value of the seats sold (`orders.subtotal_cents`, or the sum of the seat prices
  snapshotted at hold time in `order_items`).
- `booking_fee_cents`: the booking fee (S$4 per seat, charged per order). It is not split by ticket type, so
  `report_sales_by_ticket_type` has no fee column.
- `gross_revenue_cents`: what fans paid, ticket revenue plus booking fees (`orders.total_cents`).
- `sale_date` / `sale_date_sgt`: the calendar day in Singapore (`Asia/Singapore`, UTC+8) on which the payment was
  confirmed (`confirmed_at`), independent of the database session's time zone. A payment at 23:59:59 SGT counts on
  that day, one at 00:00:00 SGT on the next.
- `report_seat_status` uses the live dashboard's definitions (view `concert_seat_counts` in `0001`): a hold that
  has expired but not yet been released counts as `available`, because any checkout can take the seat at once, so
  `held` means active holds only. Counts are as of the query. Concerts without a layout show all zeros.

Example: one organiser's revenue per concert, in dollars.

```sql
SELECT concert_title, currency, seats_sold, gross_revenue_cents / 100.0 AS gross_revenue
  FROM report_sales_by_concert
 WHERE organiser_id = '<cognito sub>' AND concert_status <> 'cancelled'
 ORDER BY concert_starts_at, currency;
```

## Reports page

Route `/organiser/reports?days=7|30|90|all&concert=<id>` (code in
[`frontend/src/pages/organiser/`](../frontend/src/pages/organiser/README.md)), linked from the organiser home page
(**Reports**) and from each published concert (**View report**, which preselects that concert). Organisers only
(`organisers` Cognito group), like the other organiser pages.

Controls: period (last 7, 30 or 90 days, or all time; default 30) and concert (all or one). Both are kept in the
URL. One API call loads the whole page:

| Section | Source view | Period |
|---|---|---|
| Summary KPIs per currency: gross revenue, tickets sold, orders, average order | `report_confirmed_orders` | selected |
| Revenue by day (SVG bar chart, every Singapore day, zero days included) | `report_sales_by_day` | selected |
| Revenue by concert (bars; cancelled concerts tagged) | `report_confirmed_orders` | selected |
| Ticket types: tickets sold, orders, ticket revenue | `report_sales_by_ticket_type` | **all time** (the view has no date) |
| Seat status: available / held / sold / total, % sold | `report_seat_status` | now |
| Recent orders: newest 50, short order id, seats, total, time; no fan identity | `report_confirmed_orders` | selected |

Every section has **Download CSV**, built in the browser from the loaded data (no extra endpoint): RFC 4180
quoting, money as a decimal with two places next to a `currency` column.

### API

`GET /api/organiser/reports/sales?days=7|30|90|all&concertId=<uuid>`, `Cache-Control: no-store`. Rules (details in
the [organiser module README](../services/ticketmastery-api/src/modules/organiser/README.md)):

- Every query has `WHERE organiser_id = <caller's Cognito sub>`. A `concertId` that is not the caller's is refused
  like on every other organiser route (403 someone else's, 404 missing); a bad `days` or `concertId` is 400.
- Period: Singapore calendar days on `sale_date_sgt`. `to` is today in Singapore and `from` is `days - 1` days
  earlier; `all` has no lower bound, and its day chart starts at the first sale.
- Money is integer cents per currency. Totals, concert and day rows are grouped by currency and never added across
  currencies.
- The six section queries run in parallel on the API's connection pool (no transaction; each reads only that
  organiser's rows).

Tested against Postgres in
[`test/organiser-reports.test.ts`](../services/ticketmastery-api/test/organiser-reports.test.ts): another
organiser's sales and non-confirmed orders are excluded, the day range and zero-filled days, the concert filter and
its 403/404, totals equal to the sum of the concert rows, and 400 for an invalid period.

## QuickSight

Amazon QuickSight (now *Amazon Quick Sight*) on top of the same views was the original design: SPICE datasets per
view, a VPC connection to the private RDS, row-level security on `organiser_id`, organisers as Readers. Migration
[`0004_uc5_reporting_role.sql`](../services/ticketmastery-api/migrations/0004_uc5_reporting_role.sql) creates the
read-only `reporting_ro` role it would connect as (SELECT on the five views only). QuickSight can't be subscribed on
the project's AWS Free-plan account, so reporting is served by the organiser service instead, with the views as the
shared data layer. Switching to QuickSight later needs no change to the views.
