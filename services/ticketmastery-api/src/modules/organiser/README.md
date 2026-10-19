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
| `POST /concerts/:id/cancel` | Cancel with `{ reason }`; allowed even after the layout locks |
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
- **Cancel** sets `cancelled_at` and locks the layout; held/sold seats are left as they are.
  TODO: publish `ConcertCancelled` to SNS `order-events` (Shi Hui's topic) for ticket-fn/SES.

## Code

- `router.ts`: HTTP + zod parsing only.
- `service.ts`: ownership, lock checks, validation, transactions.
- `repository.ts`: SQL (bulk inserts via `unnest` arrays: one statement each for sections, rows, seats).
- `schemas.ts`: zod request schemas.
