# discovery module — UC1 Concert discovery

**Owner:** Cody & Nai Xin
**Mounted at:** `/api/concerts` (registered in `src/modules/index.ts`)
**Status:** stub — every route returns `501 not_implemented`.

## Planned endpoints

- `GET /api/concerts` — public list of published concerts (status scheduled/on_sale/sold_out), search/filter by artist, venue, date
- `GET /api/concerts/:id` — concert detail with ticket types and prices
- `GET /api/concerts/:id/seats` — seat map with live availability (treat held seats whose hold_expires_at < now() as available)

## Notes

- Public (no login): CloudFront caches these, so set `Cache-Control: public, max-age=...` on list/detail but keep the seat map short-lived or `no-store`.
- A simple first cut: `SELECT ... FROM concerts WHERE status IN ('scheduled','on_sale','sold_out') ORDER BY starts_at` (uses `concerts_public_listing_idx`), and `ticket_types` by `concert_id`.
- Seat availability counts: the `concert_seat_counts` view (see migration 0001).
- Follow the organiser module layout: `router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts` (zod).
- Schema changes go in a new migration; see `migrations/README.md`.
