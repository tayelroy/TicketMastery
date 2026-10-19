# waiting-room module — UC3 Virtual waiting room

**Owner:** Yan Ting
**Mounted at:** `/api/waiting-room` (registered in `src/modules/index.ts`)
**Status:** stub — every route returns `501 not_implemented`.

## Planned endpoints

- `POST /api/waiting-room/:concertId/join` — enqueue the fan (SQS FIFO `join-queue`) and return a queue position
- `GET /api/waiting-room/:concertId/status` — position / admission token from DynamoDB `live-queue`

## Notes

- Admission happens in the `queue-manager` Lambda (EventBridge Scheduler, 500 fans per minute); this API only enqueues and reports status.
- UC4 checkout should require a valid admission token for high-demand concerts.
- Follow the organiser module layout: `router.ts` (HTTP + zod parsing), `service.ts` (rules, transactions), `repository.ts` (SQL), `schemas.ts` (zod).
- Schema changes go in a new migration; see `migrations/README.md`.
