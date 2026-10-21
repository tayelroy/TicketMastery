# pages/checkout — UC4 Seat selection & checkout

**Owner:** Shi Hui
**Calls:** `/api/checkout` (API module `services/ticketmastery-api/src/modules/checkout/`)
**Status:** placeholder page.

## Routes

- `/concerts/:concertId/checkout`: pick seats, hold, pay, confirm (signed in)

## API endpoints (planned, from the API module README)

- `POST /api/checkout/holds`: hold seats for 10 minutes
- `DELETE /api/checkout/holds/:holdId`: release a hold
- `POST /api/checkout/holds/:holdId/confirm`: simulated payment, confirm the order

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- Replace `<FeaturePlaceholder>` with the real page when you build it.
