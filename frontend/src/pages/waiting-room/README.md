# pages/waiting-room — UC3 Virtual waiting room

**Owner:** Yan Ting
**Calls:** `/api/waiting-room` (API module `services/ticketmastery-api/src/modules/waiting-room/`)
**Status:** live. Joins the queue, polls the status every 5 seconds, and once queue-manager admits the fan shows
"You're in!" with a 15-minute countdown and a link to seat selection. If the API answers `501` (waiting room not
configured, e.g. local dev without AWS), `queue.ts` simulates the queue in the browser ("Demo mode" banner).

## Routes

- `/concerts/:concertId/waiting-room`: queue position and admission (signed in)

Checkout sends fans here when a hold is refused with `403 not_admitted` (not admitted yet, or the admission ran out).

## API endpoints (details in the API module README)

- `POST /api/waiting-room/:concertId/join`: join the queue (idempotent; an expired fan rejoins at the back)
- `GET /api/waiting-room/:concertId/status`: `pending` → `waiting` (position, people ahead) → `admitted` (until
  `admittedUntil`) → `expired`

Polling stops once the fan is admitted; when the countdown reaches zero the page shows "Your turn has expired" with
a rejoin button. The 15 minutes only cover starting a hold: after that the checkout's own 10-minute reservation applies.

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
