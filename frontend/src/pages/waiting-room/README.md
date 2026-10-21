# pages/waiting-room — UC3 Virtual waiting room

**Owner:** Yan Ting
**Calls:** `/api/waiting-room` (API module `services/ticketmastery-api/src/modules/waiting-room/`)
**Status:** placeholder page.

## Routes

- `/concerts/:concertId/waiting-room`: queue position and admission

## API endpoints (planned, from the API module README)

- `POST /api/waiting-room/:concertId/join`: join the queue, get a position
- `GET /api/waiting-room/:concertId/status`: position / admission token

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- Replace `<FeaturePlaceholder>` with the real page when you build it.
