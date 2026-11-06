# organiser module — UC5 Concert & Ticket Management

**Owner:** Elroy
**Mounted at:** `/api/organiser` — every route requires `authenticate` + `requireGroup('organisers')`.
Organisers only manage concerts where `organiser_id` equals their Cognito `sub` (404 missing, 403 not yours).

| Method & path | Purpose |
|---|---|
| `POST /concerts` | Create a draft concert (sale must start in the future) |
| `GET /concerts` | List my concerts |
| `GET /concerts/:id` | Detail + ticket types (with seat counts) + section/row/seat counts |
| `PUT /concerts/:id/ticket-types` | Replace the set of ticket types (matched by name; removing a type that seats use is a 409) |
| `PUT /concerts/:id/layout` | Replace the whole seat layout in one transaction |
| `POST /concerts/:id/publish` | `draft` -> `scheduled` (needs ticket types + a matching layout) |
| `POST /concerts/:id/cancel` | Cancel with `{ reason }`; allowed even after the layout locks, refused (409) once `completed`. Notifies every ticket holder (below); the response adds `cancellationNotices: { orders, published }`. On an already cancelled concert it only re-sends the notices |
| `GET /concerts/:id/dashboard` | Live available/held/sold + revenue per ticket type (`Cache-Control: no-store`) |

## Rules

- **Layout lock**: ticket types and layout are frozen once the sale starts (`sale_starts_at <= now()`), the
  concert is `on_sale`/`sold_out`/`cancelled`/`completed`, or `layout_locked_at` is set. The service checks
  this under `SELECT ... FOR UPDATE` and returns `409 layout_locked`; DB triggers enforce the same predicate
  (`concert_layout_locked(...)`) for any other writer. Seat status/hold updates are never blocked.
- **Seat count == quantity**: for every ticket type the layout must contain exactly `quantity` seats, so the
  seat map and inventory never disagree. Layout replacement and publish both enforce it.
- **Layout payload**: `{ sections: [{ name, rows: [{ label, ticketTypeName, seats: { from, to } }
  | { label, ticketTypeName, seatNumbers: ["1", "2", "2A"] }] }] }`; max 50,000 seats, 500 per row.
- **Cancel** sets `cancelled_at` and locks the layout; held/sold seats are left as they are, and checkout refuses
  holds and payments on a cancelled concert. The confirmed orders are listed in the same transaction (the concert
  row is locked `FOR UPDATE`, which waits for any checkout holding it `FOR SHARE`). After the commit, one
  `ConcertCancelled` v1 event per confirmed order goes to SNS `order-events` (`events.ts`, contract from Shi Hui's
  PR #20), and `ticket-fn` emails each fan the cancellation, reason and refund amount. Events are sent in SNS
  batches of 10, five batches at a time. A batch SNS doesn't accept is logged with its order ids and counted in
  `cancellationNotices.published`.
- **Re-sending notices**: cancelling an already cancelled concert changes nothing in the database (the original
  reason and `cancelled_at` stay; the request's `reason` is ignored) and publishes the notices for every confirmed
  order again. ticket-fn skips fans it already emailed (`tickets/<orderId>.cancelled.sent`), so only the missing
  ones go out. Use it when `published < orders`, or when the API died between the commit and the publish. The
  organiser page hides the cancel panel once a concert is cancelled, so the retry is an API call:

  ```bash
  curl -X POST "$API/api/organiser/concerts/$CONCERT_ID/cancel" -H "Authorization: Bearer $ORGANISER_TOKEN" \
    -H 'content-type: application/json' -d '{"reason": "resend"}'
  ```

  Without `ORDER_EVENTS_TOPIC_ARN` (local runs) nothing is published.

Sales reports for organisers are not here: they are the [reporting module](../reporting/README.md)
(`GET /api/reports/sales`), its own ECS service connected to RDS as the read-only `reporting_ro` role.

## Code

- `router.ts`: HTTP + zod parsing only.
- `service.ts`: ownership, lock checks, validation, transactions.
- `repository.ts`: SQL (bulk inserts via `unnest` arrays: one statement each for sections, rows, seats).
- `schemas.ts`: zod request schemas.
- `events.ts`: the `ConcertCancelled` event and its SNS publisher (`test/organiser-events.test.ts`;
  `test/organiser-cancel.test.ts` covers which orders are notified, against Postgres).
