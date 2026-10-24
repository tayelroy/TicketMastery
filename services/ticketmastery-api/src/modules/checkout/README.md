# checkout module — UC4 Seat selection & checkout

**Owner:** Shi Hui
**Mounted at:** `/api/checkout` (registered in `src/modules/index.ts`)
**Status:** seat map, hold, release and confirm implemented. `OrderConfirmed` is published to SNS when `ORDER_EVENTS_TOPIC_ARN` is set.

## Endpoints

All routes need a signed-in fan (any user; no group). `401` when anonymous.

### `GET /api/checkout/concerts/:concertId/seats` — seat map for the checkout page

The concert (with `onSale`), its ticket types, every seat grouped by section and row with `status`
`available` / `held` (by someone else) / `yours` / `sold`, `bookingFeeCentsPerSeat`, and the fan's `activeHold`
(same body as the hold response below, or `null`) so a page refresh keeps the countdown. `404` for a missing or
draft concert. A stand-in until UC1's `/api/concerts` has a seat map; it reads UC5 tables through UC4's own SQL.

### `POST /api/checkout/holds` — hold seats for 10 minutes

```json
{ "concertId": "<uuid>", "seatIds": ["<uuid>", "<uuid>"] }
```

Holds every seat or none, and creates a `pending` order priced at today's prices (prices are fixed at hold
time). `201`:

```json
{
  "holdId": "…", "orderId": "…", "concertId": "…", "status": "pending",
  "expiresAt": "2026-10-23T08:10:00.000Z", "currency": "SGD",
  "seats": [{ "seatId": "…", "section": "Floor", "row": "A", "seatNumber": "1",
              "ticketTypeId": "…", "ticketType": "VIP", "priceCents": 25000 }],
  "subtotalCents": 25000, "bookingFeeCents": 400, "totalCents": 25400
}
```

| Status | `error.code` | When |
|---|---|---|
| 400 | `validation_error` | bad body (1–20 unique seat uuids) |
| 400 | `unknown_seats` | a seat isn't in this concert (`details.seatIds`) |
| 400 | `too_many_seats` | more than the ticket type's `max_per_order` |
| 403 | `not_admitted` | not admitted from the waiting room (always admitted until UC3 exists) |
| 404 | `not_found` | no such concert |
| 409 | `not_on_sale` | concert not `scheduled`/`on_sale`, or outside its sale window |
| 409 | `active_hold_exists` | the fan already has an unexpired hold for this concert (`details.holdId`) |
| 409 | `seats_unavailable` | a seat was just taken; nothing was held (`details.seatIds` lists the taken seats) |

```bash
curl -s -X POST localhost:3000/api/checkout/holds \
  -H 'content-type: application/json' -H 'x-dev-user-id: fan-1' \
  -d '{"concertId": "<uuid>", "seatIds": ["<seat uuid>"]}'
```

### `DELETE /api/checkout/holds/:holdId` — release a hold

Frees the seats and closes the order: `cancelled`, or `expired` if the 10 minutes were already up. `200` with the
same body as above. Releasing an order that is already cancelled/expired returns it unchanged.

| Status | `error.code` | When |
|---|---|---|
| 404 | `not_found` | no such hold for this fan |
| 409 | `order_confirmed` | already paid for |

### `POST /api/checkout/holds/:holdId/confirm` — simulated payment

```json
{ "simulatePaymentFailure": false }
```

The body is optional. On success the seats become `sold` and the order `confirmed` in one transaction (`200`,
same body as above, `status: "confirmed"`), then `OrderConfirmed` is published to SNS `order-events`. Confirming an
already confirmed order returns it again (double-click safe), and re-publishes `OrderConfirmed` if it never reached
SNS (`orders.published_at IS NULL`) and the order was confirmed over a minute ago (`REPUBLISH_AFTER_SECONDS`).

| Status | `error.code` | When |
|---|---|---|
| 402 | `payment_failed` | `simulatePaymentFailure: true`; seats released, order `cancelled` |
| 404 | `not_found` | no such hold for this fan |
| 409 | `hold_expired` | the 10 minutes ran out; seats released, order `expired` |
| 409 | `concert_cancelled` | the organiser cancelled the concert; seats released, order `cancelled` |
| 409 | `hold_cancelled` | the hold was already released or its payment failed |
| 409 | `hold_expired` | (also) the order was already closed as expired |

### `OrderConfirmed` event (`events.ts`)

Published after the order commits, with message attribute `eventType = OrderConfirmed`. It carries everything
`ticket-fn` needs (order, fan id, concert title/artist/venue/start, seats, prices), so the Lambda never reads RDS.
`orders.published_at` is set once SNS accepts it. If publishing fails (or the task dies right after the order
commits), checkout still succeeds and `published_at` stays `NULL`; confirming again after a minute re-publishes, and
`WHERE status = 'confirmed' AND published_at IS NULL` finds any order still waiting. Delivery is at-least-once,
so `ticket-fn` must ignore repeats of the same `orderId`. With `ORDER_EVENTS_TOPIC_ARN` unset (local dev) the
event is only logged and `published_at` stays `NULL`.

## Data (`migrations/0002_uc4_orders.sql`)

- `orders`: one per checkout attempt (`hold_id` unique). `pending` → `confirmed` / `cancelled` / `expired`.
  Stores `subtotal_cents`, `booking_fee_cents` and `total_cents` separately, and `published_at` (above).
- `order_items`: one row per seat with the ticket type and price at hold time.
- `seats.order_id` now references `orders`, and a sold seat must have an `order_id`.

## Rules

- Booking fee: flat `BOOKING_FEE_CENTS_PER_SEAT` (S$4.00) per seat, from the proposal mockup. Assumes SGD.
- One active (unexpired, pending) hold per fan per concert, so one fan can't hoard seats across many holds.
- A fan's pending orders whose hold has run out are closed as `expired` when they release/confirm them or start
  a new hold. A fan who never comes back keeps a `pending` order with `expires_at` in the past until a sweeper
  exists (open question in `docs/architecture.md`); treat that as expired when displaying it.
- Sellable when the concert is `scheduled` or `on_sale` **and** inside its sale window. Nothing sets
  `on_sale` yet, so a published concert counts as on sale during its window. Cancelled concerts never sell.
- Seat status changes only go through `src/db/seat-holds.ts`.
- Waiting-room admission is checked through `admission.ts`, a placeholder that admits everyone until UC3's
  DynamoDB `live-queue` starts admitting fans (the table exists; the admit step is still to come).

## Layout

`router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts`
(zod), `admission.ts` (UC3 hook), `events.ts` (SNS publisher). Tests: `test/checkout.test.ts`.
