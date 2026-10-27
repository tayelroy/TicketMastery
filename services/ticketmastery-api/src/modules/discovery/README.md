# discovery module — UC1 Concert discovery

**Owner:** Cody & Nai Xin
**Mounted at:** `/api/concerts` (registered in `src/modules/index.ts`)
**Status:** implemented (public, no login). Tests: `test/discovery.test.ts`.

## Endpoints

- `GET /api/concerts`: published upcoming concerts (status scheduled/on_sale/sold_out), soonest first.
  Query params (all optional): `q` (title/artist/venue), `artist`, `venue` (case-insensitive "contains"),
  `from` / `to` (ISO datetimes on `startsAt`; `from` defaults to now), `limit` (1–100, default 50), `offset`.
  Returns `{ concerts: [{ id, title, artist, venueName, startsAt, saleStartsAt, saleEndsAt, status, imageUrl,
  minPriceCents, currency }], limit, offset }`. `Cache-Control: public, max-age=60`.
- `GET /api/concerts/:id`: concert detail plus `ticketTypes: [{ id, name, description, priceCents, currency,
  maxPerOrder, available, total }]`. Any non-draft concert resolves (so a cancelled show still shows its
  `cancellationReason`); drafts 404. `Cache-Control: public, max-age=15`.
- `GET /api/concerts/:id/seats`: `{ concertId, sections: [{ id, name, rows: [{ id, label, seats: [{ id,
  seatNumber, ticketTypeId, status }] }] }] }` where `status` is `available | held | sold`. Held seats whose
  `hold_expires_at < now()` show as `available` (same rule as `concert_seat_counts`). `Cache-Control: no-store`.

## Notes

- No `authenticate` middleware: these routes never need the user, and `AUTH_MODE=cognito` currently 501s.
- Fan-facing DTOs never expose `organiser_id`, layout-lock fields or hold owners (`held_by`, `hold_id`).
- Follows the organiser module layout: `router.ts` (HTTP + zod parsing), `service.ts` (DTOs, 404s),
  `repository.ts` (SQL), `schemas.ts` (zod).
- Schema changes go in a new migration; see `migrations/README.md`.
