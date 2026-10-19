## What & why

<!-- One or two sentences. Link the use case / issue (e.g. UC4, #12). -->

## Type

- [ ] feat
- [ ] fix
- [ ] infra (Terraform)
- [ ] docs
- [ ] chore / refactor

## Touched areas

- [ ] `services/ticketmastery-api` (module: <!-- discovery / account / waiting-room / checkout / organiser -->)
- [ ] migrations (new file only; number + uc tag: <!-- e.g. 0002_uc4_orders.sql -->)
- [ ] `infra/` (module: <!-- -->)
- [ ] `frontend/`
- [ ] `lambdas/` (function: <!-- -->)
- [ ] shared code owned by someone else (`src/db`, `src/auth`, `src/app.ts`, base infra); owner agreed beforehand

## How I tested it

<!-- Commands you ran and what you saw: docker compose up, curl output, npm test, terraform validate. -->

## Checklist

- [ ] Branch is rebased on the latest `main`
- [ ] PR title follows Conventional Commits (`feat(uc4): ...`); it becomes the squash commit
- [ ] Changes stay inside paths I own (or the owner is a reviewer)
- [ ] No secrets, `.env`, `*.tfvars`, `*.tfstate`, or plan files committed
- [ ] No edits to already-merged migrations
- [ ] Terraform: `terraform fmt -recursive infra` and `terraform validate` pass; `.terraform.lock.hcl` committed if providers changed
- [ ] Terraform: I have **not** applied, or I told the team before applying (Cody owns the account)
- [ ] Docs / README updated if behaviour, env vars, or outputs changed

## Notes for reviewers

<!-- Risks, follow-ups, open questions, screenshots. -->
