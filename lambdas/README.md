# lambdas/

> **Placeholder.** No functions are implemented yet.

Each function gets its own folder, `lambdas/<function-name>/`, containing:

- its own `package.json` (or `requirements.txt` for Python), so dependencies stay separate;
- a `README.md` covering the trigger, the environment variables it needs (names only, never values), its IAM permissions, and how to build it;
- build output in `lambdas/<function-name>/dist/`. The output and any `*.zip` artifacts are gitignored.

Infrastructure for a function (function, role, triggers, queues) belongs in its owner's Terraform module under `infra/modules/<name>/`. Don't put it in this folder. See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-terraform).

## Planned functions

| Folder | Owner | Use case | Trigger → effect | Status |
|---|---|---|---|---|
| `queue-manager/` | Yan Ting | UC3 virtual waiting room | EventBridge Scheduler (every minute during the sale window) → reads SQS FIFO `join-queue` → admits up to 500 fans per run into DynamoDB `live-queue` | planned |
| `ticket-fn/` | Shi Hui | UC4 e-tickets | SNS `order-events` → SQS `ticket-queue` (DLQ `ticket-dlq` after 5 tries) → renders the PDF to S3 at `tickets/<orderId>.pdf` (UC2's download link reads that key, see [account](../services/ticketmastery-api/src/modules/account/README.md#download-link)) and emails it via SES | planned; **name is an open question** (`ticket-fn` vs `ticket-worker`) |
| `hold-sweeper/` (optional) | TBC (Yan Ting / Shi Hui) | UC3/UC4 | Scheduled → frees expired seat holds / waiting-room slots | **open question**, see below |

### Open questions

- **`ticket-fn` vs `ticket-worker`.** Choose one name and use it for the folder, the Lambda function name, and Terraform. Rename `ticket-fn/` if the team picks `ticket-worker`.
- **Who frees expired holds?** Options:
  1. `queue-manager` also releases expired holds.
  2. Separate `hold-sweeper-fn` and/or `wr-release-fn` functions.
  3. No sweeper. UC4 checkout already reclaims expired holds atomically (`status = 'available' OR (status = 'held' AND hold_expires_at < now())`), so a sweeper would only tidy dashboard counts and waiting-room slots.

  Decide before creating `hold-sweeper/`. The full list is in [docs/architecture.md](../docs/architecture.md#open-questions).

## Rules

- A function that needs RDS runs in the base stack's `private_subnet_ids` with its own security group. Add that SG to `rds_extra_ingress_sg_ids` (see `infra/README.md`).
- DB credentials come from the RDS-managed secret (`db_secret_arn`), read at runtime with `secretsmanager:GetSecretValue`. Never put them in env files, code, or Terraform variables.
- Never write to UC5-owned tables (`concerts`, `ticket_types`, `sections`, `rows`, `seats`) other than through the canonical UC4 seat-hold statements documented in `services/ticketmastery-api/migrations/0001_uc5_concerts_ticket_types_seats.sql`.
