# checkout module — UC4 Seat selection & checkout

**Owner:** Shi Hui
**Mounted at:** `/api/checkout` (registered in `src/modules/index.ts`)
**Status:** `POST /holds` implemented; release and confirm still to come.

## Endpoints

All routes need a signed-in fan (any user; no group). `401` when anonymous.

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

### Planned

- `DELETE /api/checkout/holds/:holdId` — release a hold (order → `cancelled`)
- `POST /api/checkout/holds/:holdId/confirm` — simulated payment, mark seats sold, publish OrderConfirmed to SNS `order-events`

## Data (`migrations/0002_uc4_orders.sql`)

- `orders`: one per checkout attempt (`hold_id` unique). `pending` → `confirmed` / `cancelled` / `expired`.
  Stores `subtotal_cents`, `booking_fee_cents` and `total_cents` separately.
- `order_items`: one row per seat with the ticket type and price at hold time.
- `seats.order_id` now references `orders`, and a sold seat must have an `order_id`.

## Rules

- Booking fee: flat `BOOKING_FEE_CENTS_PER_SEAT` (S$4.00) per seat, from the proposal mockup.
- One active (unexpired, pending) hold per fan per concert, so one fan can't hoard seats across many holds.
- Sellable when the concert is `scheduled` or `on_sale` **and** inside its sale window. Nothing sets
  `on_sale` yet, so a published concert counts as on sale during its window. Cancelled concerts never sell.
- Seat status changes only go through `src/db/seat-holds.ts`.
- Waiting-room admission is checked through `admission.ts`, a placeholder that admits everyone until UC3's
  DynamoDB `live-queue` starts admitting fans (the table exists; the admit step is still to come).

## Layout

`router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts`
(zod), `admission.ts` (UC3 hook). Tests: `test/checkout.test.ts`.
