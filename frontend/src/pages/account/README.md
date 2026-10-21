# pages/account — UC2 My Tickets & Account

**Owner:** Andrew
**Calls:** `/api/me` (API module `services/ticketmastery-api/src/modules/account/`)
**Status:** placeholder page.

## Routes

- `/myaccount`: my tickets and orders (signed in)
- `/myaccount/tickets/:ticketId`: one e-ticket (signed in)

## API endpoints (planned, from the API module README)

- `GET /api/me`: profile
- `GET /api/me/orders`: my orders
- `GET /api/me/tickets/:id/download`: 5-minute pre-signed e-ticket URL

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- Replace `<FeaturePlaceholder>` with the real page when you build it.
