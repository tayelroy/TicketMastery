# Contributing to TicketMastery

There are five of us and one AWS account. These rules keep us from overwriting each other's work and from leaking secrets.

- [Git workflow](#git-workflow)
- [Ownership](#ownership)
- [Adding API routes](#adding-api-routes)
- [Adding database tables](#adding-database-tables)
- [Adding Terraform](#adding-terraform)
- [Secrets](#secrets)
- [Local development](#local-development)

## Git workflow

- **Never push to `main`.** All changes reach `main` through a pull request.
- Branch from an up-to-date `main` and use these names:

  | Prefix | Use | Example |
  |---|---|---|
  | `feat/<uc>-<short>` | new feature for a use case | `feat/uc4-seat-hold` |
  | `fix/<uc-or-area>-<short>` | bug fix | `fix/uc5-layout-lock-409` |
  | `infra/<short>` | Terraform | `infra/waiting-room-sqs` |
  | `docs/<short>` | docs only | `docs/deploy-steps` |
  | `chore/<short>` | tooling, deps | `chore/bump-pg` |

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles. The PR title becomes the squash commit message.

  ```
  feat(uc4): hold seats atomically for 10 minutes
  fix(infra): open rds_sg to queue-manager lambda
  docs: add cost estimate
  ```

  Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `infra`. The scope is the use case (`uc1`–`uc5`) or the area (`infra`, `api`, `frontend`, `lambdas`).
- Keep PRs small: one concern each, roughly under 400 changed lines. Split schema, API, and Terraform changes into separate PRs when you can.
- Before merging, **rebase on `main`** (`git fetch && git rebase origin/main`) and make sure checks still pass. Force-push to your own branch with `--force-with-lease`. Never force-push to a branch someone else is working on.
- Every PR needs **at least one approving review from a CODEOWNER of each path it touches** (see [`.github/CODEOWNERS`](.github/CODEOWNERS)). Your own approval doesn't count. GitHub only enforces this once branch protection on `main` has "Require review from Code Owners" turned on.
- **Squash merge** only. Delete the branch after merging.
- Fill in the [PR template](.github/pull_request_template.md).

## Ownership

`.github/CODEOWNERS` is the source of truth for review routing. The table below is a summary of it.

| Path | Owner | Notes |
|---|---|---|
| `infra/` (base: `envs/dev`, `modules/{network,security,ecr,rds,ecs-service}`) | Elroy | VPC, ALB, ECS, RDS, ECR |
| `infra/modules/edge/` | Cody | S3, CloudFront, WAF, Route 53 |
| `infra/modules/auth-apigw/` | Andrew | Cognito, API Gateway |
| `infra/modules/waiting-room/` | Yan Ting | SQS FIFO, DynamoDB, scheduler |
| `infra/modules/messaging/` | Shi Hui | SNS, SQS, DLQ, SES |
| `services/ticketmastery-api/` base (`src/app.ts`, `src/db/`, `src/auth/`, `src/modules/index.ts`, `migrations/README.md`, Dockerfile, compose) | Elroy | Ask before changing shared code |
| `services/ticketmastery-api/src/modules/organiser/` + `migrations/*_uc5_*` | Elroy | UC5 |
| `services/ticketmastery-api/src/modules/discovery/` + `migrations/*_uc1_*` | Cody, Nai Xin | UC1 |
| `services/ticketmastery-api/src/modules/account/` + `migrations/*_uc2_*` | Andrew | UC2 |
| `services/ticketmastery-api/src/modules/waiting-room/` + `migrations/*_uc3_*` | Yan Ting | UC3 |
| `services/ticketmastery-api/src/modules/checkout/` + `migrations/*_uc4_*` | Shi Hui | UC4 |
| `frontend/` | Nai Xin | Hosting by Cody |
| `lambdas/queue-manager/` | Yan Ting | UC3 |
| `lambdas/ticket-fn/` | Shi Hui | UC4 e-tickets |
| AWS account, deploy pipeline | Cody | |

## Adding API routes

There is one service, `services/ticketmastery-api`, and it hosts every use case. Each use case owns one module, mounted under `/api`. The current mounts in `src/modules/index.ts` are:

| Module folder | Mounted at | UC |
|---|---|---|
| `discovery` | `/api/concerts` | UC1 |
| `account` | `/api/me` | UC2 |
| `waiting-room` | `/api/waiting-room` | UC3 |
| `checkout` | `/api/checkout` | UC4 |
| `organiser` | `/api/organiser` | UC5 |

1. Write your code in `src/modules/<name>/`. The entry point is `src/modules/<name>/router.ts`, which exports a named Express `Router` (e.g. `export const checkoutRouter = Router()`).
2. Register the router once by adding an entry `{ basePath, router, useCase, owner }` to the `modules` array in `src/modules/index.ts`. `src/app.ts` mounts each entry at `/api${basePath}`. That one entry is the only change you make in a shared file. Everything else stays inside your module folder.
3. Don't import from another team's module. If you need their data, read their tables through SQL you own, or agree on an exported function with the owner.
4. The shared helpers in `src/db/` (pool, transactions, migration runner, seat-hold reference) and `src/auth/` (dev-header stub, Cognito verification, group checks) are owned by **Elroy**. Ask before changing them, and open a separate PR if a change is needed.
5. Auth: during development, `AUTH_MODE=dev-header` reads `x-dev-user-id` and `x-dev-user-groups` (comma-separated, e.g. `organisers`). Use the shared middleware in `src/auth` and never read those headers directly, so the switch to Cognito JWTs needs no change in your module.
6. `/health` at the root (DB check) belongs to the base. Don't add other root-level routes.

## Adding database tables

The schema is plain SQL in `services/ticketmastery-api/migrations/`. A small runner applies the files in order inside a transaction, takes a Postgres advisory lock so concurrent tasks don't race, and checksums every applied file.

1. Add a **new** file named `NNNN_<uc>_<description>.sql`. `NNNN` is the next free 4-digit number on `main` and `<uc>` is your use-case tag, e.g. `0002_uc4_orders.sql` or `0003_uc3_queue_audit.sql`.
2. If someone merges the same number before you, rebase and renumber your file. Its content doesn't change.
3. **Never edit a migration once it is merged.** The runner checksums applied files and refuses to start if one changed. To change something, add another migration.
4. Only create or alter **your own** tables. Put a header comment in each file naming the owner.
5. Foreign keys into UC5 tables (`concerts`, `ticket_types`, `seats`, and `sections`/`rows` if needed) are allowed. Don't alter UC5 tables. Ask Elroy for a column or index instead.
6. **Seat status and hold columns** (`status`, `held_by`, `hold_id`, `held_at`, `hold_expires_at`, `sold_at`, `order_id`) are written only by UC4 checkout (and an agreed hold sweeper), using the canonical atomic `UPDATE` documented in `migrations/0001_uc5_concerts_ticket_types_seats.sql` (reference implementation in `src/db/seat-holds.ts`). A hold is all-or-nothing: if the `UPDATE` returns fewer rows than requested, roll back. Expired holds are reclaimed through `status = 'available' OR (status = 'held' AND hold_expires_at < now())`.
7. Don't put `BEGIN`/`COMMIT` in migration files. The runner wraps each file in a transaction.
8. Migrations run on container start when `RUN_MIGRATIONS_ON_START=true`, so a broken migration stops the deploy. Test it locally with `docker compose up --build` first.

## Adding Terraform

The `infra/README.md` has a worked example.

1. Put your resources in your own module, `infra/modules/<name>/` (`edge`, `auth-apigw`, `waiting-room`, `messaging`, …), with `versions.tf`, `variables.tf`, `main.tf`, and `outputs.tf`.
2. Wire it into `infra/envs/dev/main.tf` with a `module "<name>"` block. Pass shared values in as variables taken from base outputs. Don't look up or hardcode IDs. Available outputs include `vpc_id`, `private_subnet_ids`, `public_subnet_ids`, `ecs_sg_id`, `rds_sg_id`, `db_secret_arn`, `alb_listener_arn`, `alb_dns_name`, and `task_role_name`.
3. Grant the API access from inside your module with a least-privilege `aws_iam_role_policy` on `task_role_name`. Pass non-secret values to the API through `extra_environment`.
4. Before opening a PR, run:

   ```bash
   terraform fmt -recursive infra
   terraform -chdir=infra/envs/dev init -backend=false
   terraform -chdir=infra/envs/dev validate
   ```

   Commit `.terraform.lock.hcl` whenever providers change.
5. **Never commit** `*.tfvars` (only `terraform.tfvars.example`), `*.tfstate*`, `.terraform/`, or plan files. The root `.gitignore` blocks them. Don't force-add them.
6. **Never run `terraform apply` or `destroy` without telling the team in the group chat first.** Cody owns the AWS account. While state is local, only one person applies `dev`. See [docs/deploy.md](docs/deploy.md).

## Secrets

- Never commit secrets: no passwords, API keys, AWS access keys, JWTs, `.pem`/`.key` files, or `.env` files. Commit a `.env.example` with variable **names** and dummy values instead.
- Runtime secrets live in **AWS Secrets Manager**. The RDS master password is managed by RDS (`db_secret_arn`). ECS injects it through task-definition `secrets`. Lambdas read it at runtime using IAM.
- No secrets in Terraform variables, `extra_environment`, Lambda environment variables, logs, screenshots, or PR descriptions.
- Use AWS credentials from your own profile (`AWS_PROFILE`, SSO preferred). Never use long-lived access keys in files inside the repo.
- If a secret is committed by mistake, tell the team **immediately** and rotate it. Deleting the commit doesn't help because the secret stays in history and forks.

## Local development

You need Docker and, optionally, Node 20.

```bash
cd services/ticketmastery-api
docker compose up --build
curl http://localhost:3000/health
```

Compose runs PostgreSQL plus the API with `AUTH_MODE=dev-header` and migrations on start. Call authenticated routes with the dev headers:

```bash
curl -H 'x-dev-user-id: organiser-1' -H 'x-dev-user-groups: organisers' http://localhost:3000/api/organiser/...
```

See `services/ticketmastery-api/README.md` for running without Docker, seeding, and tests. Deploying to AWS is covered in [docs/deploy.md](docs/deploy.md).
