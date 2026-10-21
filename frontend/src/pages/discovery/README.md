# pages/discovery — UC1 Concert discovery

**Owner:** Cody & Nai Xin
**Calls:** `/api/concerts` (API module `services/ticketmastery-api/src/modules/discovery/`)
**Status:** placeholder page.

## Routes

- `/`: concert list (public)
- `/concerts/:concertId`: concert detail + seat map (public)

## API endpoints (planned, from the API module README)

- `GET /api/concerts`: published concerts, search/filter by artist, venue, date
- `GET /api/concerts/:id`: detail with ticket types and prices
- `GET /api/concerts/:id/seats`: seat map with live availability

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- Replace `<FeaturePlaceholder>` with the real page when you build it.
