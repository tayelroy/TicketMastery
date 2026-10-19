# ticketmastery-api

The single backend service for TicketMastery: Node 20 + Express 4 + TypeScript, `pg` (no ORM), `zod`,
`pino`. Runs on ECS Fargate (private subnets, 2 AZs) behind API Gateway -> ALB, talking to RDS PostgreSQL.

UC5 (organiser concert & ticket management) is implemented; UC1–UC4 modules are registered stubs that
return `501` until their owners fill them in.

## Run locally

Requires Docker.

```bash
cd services/ticketmastery-api
docker compose up --build          # Postgres 16 + API on http://localhost:3000; migrations run on start
docker compose run --rm api node dist/db/seed.js   # optional demo concert for org-1
curl localhost:3000/health
```

`docker compose down -v` wipes the database volume. The compose credentials (`tm` / `tm_local_dev_only`)
are for local use only.

Without Docker for the API (Node 20+, Postgres from compose):

```bash
npm ci
cp .env.example .env               # never commit .env
docker compose up -d postgres
npm run migrate:dev
npm run seed
npm run dev                        # tsx watch, loads .env
```

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch` with `.env` |
| `npm run build` / `npm start` | compile to `dist/` / run compiled server |
| `npm run migrate` / `npm run migrate:dev` | apply migrations (compiled / tsx + `.env`) |
| `npm run seed` / `npm run seed:prod` | idempotent demo seed (tsx + `.env` / compiled) |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | Postgres integration tests (see below) |

### Tests

`test/seat-inventory.test.ts` checks the layout-lock triggers and the all-or-nothing seat hold (two
concurrent holds on the same seats: exactly one wins; expired holds are reclaimable). It needs a real
Postgres and is skipped when `DB_HOST` is unset. It works in a throwaway schema that it drops afterwards:

```bash
DB_HOST=localhost DB_NAME=ticketmastery DB_USER=tm DB_PASSWORD=tm_local_dev_only npm test
```

## Organiser flow (dev-header auth)

With `AUTH_MODE=dev-header` the API trusts `x-dev-user-id` and `x-dev-user-groups` instead of a Cognito
JWT. Organiser routes need the `organisers` group.

```bash
API=http://localhost:3000/api/organiser
H=(-H 'content-type: application/json' -H 'x-dev-user-id: org-1' -H 'x-dev-user-groups: organisers')

# 1. create a draft concert (sale must start in the future and end before the show)
CID=$(curl -s "${H[@]}" -X POST $API/concerts -d '{
  "title": "Cloud Nine Live", "artist": "The Cloud Natives",
  "venueName": "Singapore Indoor Stadium", "venueAddress": "2 Stadium Walk",
  "saleStartsAt": "2027-01-10T02:00:00Z", "saleEndsAt": "2027-02-27T12:00:00Z",
  "startsAt": "2027-02-28T12:00:00Z"
}' | sed -E 's/.*"id":"([^"]+)".*/\1/')

# 2. ticket types (prices in cents; currency defaults to SGD)
curl -s "${H[@]}" -X PUT $API/concerts/$CID/ticket-types -d '{"ticketTypes": [
  {"name": "CAT1", "priceCents": 18800, "quantity": 20},
  {"name": "CAT2", "priceCents": 12800, "quantity": 10}
]}'

# 3. seat layout: seats per ticket type must equal its quantity
curl -s "${H[@]}" -X PUT $API/concerts/$CID/layout -d '{"sections": [
  {"name": "Left",  "rows": [{"label": "A", "ticketTypeName": "CAT1", "seats": {"from": 1, "to": 10}}]},
  {"name": "Right", "rows": [{"label": "A", "ticketTypeName": "CAT1", "seats": {"from": 1, "to": 10}},
                             {"label": "B", "ticketTypeName": "CAT2", "seatNumbers": ["1","2","3","4","5","6","7","8","9","10"]}]}
]}'

# 4. inspect, publish, watch the dashboard
curl -s "${H[@]}" $API/concerts/$CID
curl -s "${H[@]}" -X POST $API/concerts/$CID/publish
curl -s "${H[@]}" $API/concerts/$CID/dashboard

# 5. cancel (also allowed after the sale opens)
curl -s "${H[@]}" -X POST $API/concerts/$CID/cancel -d '{"reason": "Artist unwell"}'
```

Errors are JSON: `{"error": {"code", "message", "details?"}}`. Validation -> 400, no user -> 401, not an
organiser / not your concert -> 403, unknown concert -> 404, locked layout / wrong status / unique
conflict -> 409.

## Routes and modules

- `GET /health` (root, not `/api`): readiness for the **ALB target group**; runs `SELECT 1` with a 2s
  timeout. `200 {status:"ok", db:"ok", uptimeSeconds, version}` or `503 {status:"error", db:"down"}`.
- `GET /health/live`: liveness, no DB (Docker `HEALTHCHECK`), so a DB blip does not kill every task.
- Everything else is under `/api`, mounted from the registry in `src/modules/index.ts`:

| Path | Module | Use case | Owner | Status |
|---|---|---|---|---|
| `/api/concerts` | `discovery` | UC1 Concert discovery | Cody & Nai Xin | stub (501) |
| `/api/me` | `account` | UC2 My Tickets & Account | Andrew | stub (501) |
| `/api/waiting-room` | `waiting-room` | UC3 Virtual waiting room | Yan Ting | stub (501) |
| `/api/checkout` | `checkout` | UC4 Seat selection & checkout | Shi Hui | stub (501) |
| `/api/organiser` | `organiser` | UC5 Concert & ticket management | Elroy | implemented |

Each module has a `README.md` with its planned endpoints.

### Adding a route or module

1. Put the code in `src/modules/<name>/`: `router.ts` (HTTP + zod parsing), `service.ts` (rules,
   `withTransaction`), `repository.ts` (SQL taking a `Queryable`), `schemas.ts` (zod). Use
   `src/modules/organiser/` as the reference.
2. Wrap async handlers in `asyncHandler` (Express 4 does not catch rejected promises) and throw
   `HttpError(status, code, message)` for expected failures. Postgres constraint errors are mapped centrally
   in `src/http/errors.ts`.
3. Protect routes with `authenticate` and, where needed, `requireGroup('<group>')` (`src/auth`).
4. New module: add `{ basePath, router, useCase, owner }` to `src/modules/index.ts`.
5. Seat holds (UC4): use `src/db/seat-holds.ts`, not hand-written variants.

### Adding a migration

Add `migrations/NNNN_<uc-or-owner>_<description>.sql` with the next free number. Never edit a merged
migration. Details: [`migrations/README.md`](migrations/README.md).

## Configuration

Validated with zod at startup (`src/config.ts`); invalid config exits with a list of problems.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` / `test` / `production` |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | pino level |
| `APP_VERSION` | package.json version | reported by `/health`; set to the git SHA in the pipeline |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | required | `DB_PASSWORD` from Secrets Manager in ECS |
| `DB_PORT` | `5432` | |
| `DB_SSL` | `false` | `true` on RDS (TLS without CA verification; see `src/db/pool.ts` for the RDS CA bundle) |
| `DB_POOL_MAX` | `10` | per task; keep `tasks x DB_POOL_MAX` under RDS `max_connections` |
| `AUTH_MODE` | `dev-header` | `dev-header` or `cognito` (cognito returns 501 until implemented) |
| `ALLOW_DEV_AUTH` | `false` | must be `true` to run `dev-header` with `NODE_ENV=production`; logs a warning |
| `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | unset | placeholders for Cognito verification |
| `RUN_MIGRATIONS_ON_START` | `false` | migrate (advisory-locked) before listening |

### AWS notes

- The ECS task currently runs `AUTH_MODE=dev-header` with `ALLOW_DEV_AUTH=true` until Andrew's Cognito
  integration lands. **In that mode anyone who can reach the API can act as any user or organiser** by
  sending `x-dev-user-*` headers (API Gateway forwards them). Do not put real data behind it; switching to
  `AUTH_MODE=cognito` is the fix.
- ALB idle timeout is 60s; the server's keep-alive timeout is 65s to avoid sporadic 502s.
- SIGTERM (ECS stop) closes the HTTP server and the pool, exiting within 25s.
- The Docker `HEALTHCHECK` only applies if the task definition defines `healthCheck`; the ALB uses `/health`.

## Why Node/Express + TypeScript

- One language across the frontend, this API and the Lambdas (`queue-manager`, `ticket-fn`), and the team
  already knows it.
- `pg` is mature and lets us write the seat-hold SQL directly (row locks, `FOR UPDATE`, triggers), which
  matters more than ORM convenience for zero double-booking.
- Small container (node:20-alpine, prod deps only), quick task start-up when Fargate scales out for an
  on-sale.
- FastAPI (Python) was the alternative: equally capable, but a second language for the team to maintain.
