# checkout module — UC4 Seat selection & checkout

**Owner:** Shi Hui
**Mounted at:** `/api/checkout` (registered in `src/modules/index.ts`)
**Status:** stub — every route returns `501 not_implemented`.

## Planned endpoints

- `POST /api/checkout/holds` — hold seats for 10 minutes (all-or-nothing)
- `DELETE /api/checkout/holds/:holdId` — release a hold
- `POST /api/checkout/holds/:holdId/confirm` — simulated payment, mark seats sold, publish OrderConfirmed to SNS `order-events`

## Notes

- Use the canonical statements in `src/db/seat-holds.ts` (`holdSeats`, `confirmHold`, `releaseHold`, `sweepExpiredHolds`) inside `withTransaction`; the contract and the concurrency argument are documented at the bottom of `migrations/0001_uc5_concerts_ticket_types_seats.sql`.
- Add the `orders` table in your own migration (e.g. `0002_uc4_orders.sql`), then add the FK from `seats.order_id` and tighten `seats_sold_chk` to require `order_id`.
- Refuse holds unless the concert is `on_sale` and inside its sale window; cancelled concerts must not sell.
- Follow the organiser module layout: `router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts` (zod).
- Schema changes go in a new migration; see `migrations/README.md`.
