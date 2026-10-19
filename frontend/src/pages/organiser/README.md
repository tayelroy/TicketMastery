# pages/organiser — UC5 Concert & ticket management

**Owner:** Elroy
**Calls:** `/api/organiser` (API module `services/ticketmastery-api/src/modules/organiser/`)
**Status:** placeholder page.

## Routes

- `/organiser`: my concerts (needs the `organisers` group)

## API endpoints (planned, from the API module README)

Implemented. See `services/ticketmastery-api/src/modules/organiser/README.md` for the full list
(`POST/GET /concerts`, `PUT /concerts/:id/ticket-types`, `PUT /concerts/:id/layout`, `POST /concerts/:id/publish`,
`POST /concerts/:id/cancel`, `GET /concerts/:id/dashboard`).

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- Replace `<FeaturePlaceholder>` with the real page when you build it.
