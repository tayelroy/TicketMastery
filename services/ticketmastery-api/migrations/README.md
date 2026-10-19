# Database migrations

Plain SQL files applied in filename order by `src/db/migrate.ts`, which:

- records each file in `schema_migrations (filename, checksum, applied_at)`;
- takes a Postgres advisory lock first, so several ECS tasks starting together (or a task plus a manual
  run) apply migrations once, one runner at a time;
- runs each new file in its own transaction (a failing file leaves no partial schema and stops the run);
- refuses to start if an already-applied file's contents changed (sha256; CRLF/LF differences ignored).

Run them with `npm run migrate:dev` (local, tsx), `npm run migrate` (compiled, e.g. a one-off ECS task), or
`RUN_MIGRATIONS_ON_START=true` (the API migrates before listening; docker compose does this).

## Naming

```
NNNN_<uc-or-owner>_<description>.sql
0001_uc5_concerts_ticket_types_seats.sql
0002_uc4_orders.sql
0003_uc2_user_profiles.sql
```

- `NNNN`: 4-digit sequence. Numbers are **not** reserved per person or per use case: take the next free
  number when you create the file. If someone merges the same number first, rebase and renumber yours
  (the runner rejects duplicate numbers).
- `<uc-or-owner>`: lowercase use case (`uc1`..`uc5`), or the owner/area for work outside a use case
  (`shared`, `elroy`, ...). One lowercase word, no underscores.
- `<description>`: lowercase snake_case.

## Rules

- **Never edit a migration that has been merged/applied anywhere.** Write a new one (`ALTER TABLE ...`).
- No `BEGIN`/`COMMIT` in files; the runner wraps each file in a transaction. That also means no
  `CREATE INDEX CONCURRENTLY` (fine at our data size).
- Prefer constraints (CHECK, FK, UNIQUE) over app-only validation; the API maps constraint errors to 4xx.
- Changes to another use case's tables need that owner's review.

## Ownership

| File | Owner | Tables |
|------|-------|--------|
| `0001_uc5_concerts_ticket_types_seats.sql` | Elroy (UC5) | `concerts`, `ticket_types`, `sections`, `rows`, `seats`, view `concert_seat_counts`, layout-lock triggers |

Seat hold columns on `seats` (`status`, `held_by`, `hold_id`, `held_at`, `hold_expires_at`, `sold_at`,
`order_id`) are the contract with UC4 (Shi Hui); the canonical hold/confirm/release/sweep statements and why
they are race-free are documented at the bottom of `0001` and implemented in `src/db/seat-holds.ts`.
UC4 adds its own `orders` table in a new migration, then the FK `seats.order_id -> orders.id`.
