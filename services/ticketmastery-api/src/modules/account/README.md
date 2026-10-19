# account module — UC2 My Tickets & Account

**Owner:** Andrew
**Mounted at:** `/api/me` (registered in `src/modules/index.ts`)
**Status:** stub — every route returns `501 not_implemented`.

## Planned endpoints

- `GET /api/me` — profile from Cognito claims
- `GET /api/me/orders` — the signed-in fan's orders
- `GET /api/me/tickets/:id/download` — 5-minute pre-signed S3 URL for the e-ticket PDF

## Notes

- Every query must filter by `req.user.sub`; fans only ever see their own tickets.
- Andrew also owns real Cognito verification in `src/auth/index.ts` (AUTH_MODE=cognito).
- Follow the organiser module layout: `router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts` (zod).
- Schema changes go in a new migration; see `migrations/README.md`.
