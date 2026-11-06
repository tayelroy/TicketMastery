# Canva edits for the final deck (6 Nov 2026 sync)

Source deck: `TicketMastery concert ticketing on AWS.pdf` (24 pages). Numbers come from the 6 Nov live system; costs are
estimates from `docs/cost-estimate.md`. Speaker notes for each slide are in `slides.md`.

**Deck vs `slides.md`.** The deck has 24 pages, `slides.md` 21 slides. The three extra pages take time from their
neighbours: Agenda (page 2) is inside slide 1's 0.50 min, Target HA (page 7) inside slide 5's 1.00 min, and "0 seats
sold twice" (page 19) inside slide 16's 0.75 min, so the total stays 18.75 + 1.00 buffer. The Canva deck is the one
we present; the old generated `slides.pptx` was removed so there is only one deck. Export the edited Canva deck to PDF
for submission.

## Page 1 — Title
- Old: "Five use cases, built and running in ap-southeast-1" → New: "Five use cases on six ECS services, running in ap-southeast-1"

## Page 2 — Agenda
No change.

## Page 3 — Business context and requirements
No change.

## Page 4 — What changed, and why
- Row 2, Proposal column. Old: "All-serverless write-up (report §3.1)" (repeats row 1) → New: "One API container for all features"
- Row 2, Built column. Old: "Serverless kept where it fits: the waiting room (SQS FIFO, DynamoDB, Lambda) and the e-ticket worker (SNS → SQS → Lambda)" → New: "Six ECS services from one image (one per feature + read-only reporting), each with its own scaling. Serverless kept for the waiting room and e-ticket worker"

## Page 5 — Instructor feedback and our response
- Row b, response. Old: "One service, five isolated modules with their own migrations; split later" → New: "Six ECS services from one image, each with its own target group, path rule and autoscaling"
- Row b, status. Old: "Trade-off" → New: "Done"
- Row e, response. Old: "Live dashboard + five tested SQL views; QuickSight designed, not deployed" → New: "Read-only reporting service (`reporting_ro`, five SQL views) + Sales reports page; QuickSight blocked on the AWS Free plan"
- Row e, status. Old: "Data layer done" → New: "Done (no BI tool)"

## Page 6 — Deployed: implementation mode
- Image: replace the diagram with `figures/implementation-architecture.png` (regenerated: six services, 31 alarms, no QuickSight).
- Card. Old: "1 Fargate task" → New: "6 Fargate services, 1 task each"
- Price card. Old: "≈ $72" / "USD per month, whole stack" → New: "≈ $150" / "USD per month, whole stack (estimate)"

## Page 7 — Target: high-availability design
- Image: replace with `figures/target-ha-architecture.png` (regenerated; QuickSight removed).
- Card. Old: "2–4+ tasks" → New: "≥ 2 tasks per service (12)"
- Price card. Old: "≈ $194" → New: "≈ $310"
- Footer. Old: "TicketMastery on AWS · 07 · Same Terraform; check blocks reject invalid combinations" → New: "TicketMastery on AWS · 07 · Design only, as the instructor asked; same Terraform (preconditions block, check blocks warn)"

## Page 8 — Resource allocation and justification
| Row | Old | New |
|---|---|---|
| Edge | "CloudFront PriceClass_200; WAF with 3 rules" · "≈ 8" | "CloudFront PriceClass_200; WAF: 1 web ACL, 2 rules" · "≈ 7" |
| Compute | "Fargate 1 × 0.25 vCPU / 0.5 GB; scales at CPU 60%, 500 req/task/min" · "11.3" | "Fargate 6 services × 1 task × 0.25 vCPU / 0.5 GB; each scales on CPU 60% + requests/task; ≈ 60 req/s per task → max 3" · "67.2" |
| Public IPv4 | "A task public IP instead of a NAT gateway (≈ 43 per AZ)" · "3.65" | "One public IP per task instead of a NAT gateway (≈ 43 per AZ)" · "21.9" |
| Secrets, ECR, logs | "≈ 1.5" | "1.8" (2 secrets 0.8, logs 0.9, ECR 0.1) |
| Monitoring | "Alarms, dashboard, custom metrics, SNS email" · "≈ 1.3" | "31 alarms, dashboard, custom metrics, SNS email" · "≈ 6.4" |
| Whole stack | "≈ 72" | "≈ 150" |

## Page 9 — Linkage of resources
- Request path. Old: "CloudFront → API Gateway (JWT) → VPC link → internal ALB → Fargate → RDS" → New: "CloudFront → API Gateway (JWT) → VPC link → internal ALB (path rule per service) → 6 Fargate services → RDS"
- Security groups and IAM. Old: "VPC link → ALB (80) → task → RDS (5432); one least-privilege role per component" → New: "VPC link → ALB (80) → task → RDS (5432); own roles for the Lambdas, Scheduler and GitHub Actions; the six API services share one task role; reporting logs in as `reporting_ro`"
- Image: replace the sequence diagram with the regenerated `figures/purchase-sequence.png` (waiting-room and checkout services; marker check → PDF → Cognito → SES → `.sent`).

## Page 10 — UC1 Concert discovery
No change.

## Page 11 — UC2 My Tickets and account
No change.

## Page 12 — UC3 Virtual waiting room
No change.

## Page 13 — UC4 Seat holds, checkout and e-tickets
No change.

## Page 14 — UC5 Concert management and reporting
- Bullet 5. Old: "Five tested SQL reporting views; QuickSight designed, not deployed" → New: "Sales reports page (7/30/90 days or all, KPIs, charts, CSV) from a read-only reporting service"
- Image: replace the dashboard screenshot with `evidence/demo/demo-18-organiser-reports.png`.

## Page 15 — Live demo
- Organiser. Old: "Create and publish a concert, open the live dashboard (UC5)" → New: "Create and publish a concert, open the live dashboard and Sales reports (UC5)"
- Screenshot grid: optional, swap "UC5 live organiser dashboard" tile for `demo-18-organiser-reports.png`.

## Page 16 — Monitoring and alerts
- Card 1. Old: "20" / "CloudWatch alarms → SNS → email" → New: "31" / "CloudWatch alarms → SNS → email"
- Card 2. Old: "16" / "dashboard graphs with thresholds" → New: "19" / "dashboard graphs with thresholds, one line per service on the ECS graphs"
- Add one line under "Fired for real…": "Per service: no healthy hosts + at max capacity; CPU/memory on the busiest service (41 → 30 after cutting noise, + NFR-7 delivery-latency alarm = 31)"
- "Forced alarm" text, if present: "ALARM and OK emails 46 s apart" (not "within the same minute")

## Page 17 — Scalability and availability
- Add after "Measured": "**6 Nov, six services:** 10 → 100 req/s, 57,600 requests, 0 dropped, p95 63 ms; only discovery scaled (1 → 3 tasks in 5.6 min)"
- Any "4–5 min" scale-out text → "4–6 min"
- Add: "100,000 fans polling every 5 s ≈ 20,000 req/s vs 100 rps throttle → 429 + retry; production: per-route throttles, backoff, raised quota, CloudFront TTL"
- Autoscaling box. Old: "CPU 60%, 500 req/task/min" → New: "Per service: CPU 60% + requests/task"
- Image: replace the graph with `evidence/nfr2-burst-run3-tasks-per-service.png` (CloudWatch, 6 Nov 02:08–02:30 UTC: running tasks per service; discovery goes 1 → 3, the other four stay at 1). Or put it next to the old graph if there is room.

## Page 18 — NFR results
- NFR-2 row, Measured. Old: "1 task: 3.3% failed; 2 tasks: 0" → New: "1 task: 3.3% failed; 2 tasks: 0; 6 services: 0 dropped, scale-out 5.6 min"
- NFR-2 row, Result. Old: "Run 1 fail, run 2 pass" → New: "Run 1 fail, runs 2–3 pass (scale-out > 5 min)"

## Page 19 — 0 seats sold twice
No change.

## Page 20 — Management approach
- CI/CD. Old: "Frontend type-check and build on PRs; deploy from main through GitHub OIDC with no AWS keys; API image tagged with the git SHA, scanned in ECR, circuit-breaker rollback" → New: "CI on PRs and main: API type-check + tests on Postgres 16 (coverage gate), ticket-fn tests, terraform fmt + validate, frontend build. Frontend deploys from main through GitHub OIDC (no AWS keys). API rollout still manual: image tagged with the git SHA, pushed to ECR (scanned), Terraform apply; circuit-breaker rollback"

## Page 21 — Security, backup and DR
- Edge row. Old: "HTTPS only; WAF; S3 only through OAC" → New: "HTTPS only; WAF (1 web ACL, 2 rules); S3 only through OAC"
- Secrets row. Old: "DB password from RDS in Secrets Manager" → New: "DB password from RDS in Secrets Manager; `reporting_ro` read-only login in its own secret"

## Page 22 — Cost and Budgets
- Card 1. Old: "≈ $72" / "Deployed, per month (≈ 2.4/day)" → New: "≈ $150" / "Deployed, per month (≈ 4.9/day)"
- Card 2. Old: "≈ $194" / "Target HA, per month (≈ 6.4/day)" → New: "≈ $310" / "Target HA, per month (≈ 10.2/day)"
- Budgets text. Old: "…alerts at 20, 40, 60, 80 actual and on a forecast above 80" → New: "…alerts at 20, 40, 60, 80 actual and on a forecast above 80; the new run rate exceeds 80"
- Spent text. Old: "USD 22.92 in October, all credits; terraform destroy after work sessions" → New: "USD 22.92 in October, all credits; project total ≈ USD 58 with November (estimate); USD 123.33 left (6 Nov); terraform destroy after work sessions"

| Row | Old Deployed / HA | New Deployed / HA |
|---|---|---|
| Fargate 0.25 vCPU / 0.5 GB | 11.3 (1 task) / 22.6 (2 tasks) | 67.2 (6 tasks × 11.2) / 134.4 (12 tasks) |
| Public IPv4 | 3.65 / 0 | 21.9 / 0 |
| Secrets, logs, ECR | ≈ 1.3 / ≈ 1.5 | 1.8 / 1.8 |
| WAF, 1 ACL, 3 rules | ≈ 8 / ≈ 8 | label "WAF, 1 ACL, 2 rules" · ≈ 7 / ≈ 7 |
| Monitoring, pay-per-request | ≈ 2 / ≈ 2 | ≈ 6.7 / ≈ 6.7 |
| Whole stack | ≈ 72 / ≈ 194 | ≈ 150 / ≈ 310 |

## Page 23 — Limitations and future work
- Design only. Old: "HA, Multi-AZ RDS and permanent autoscaling: a tfvars change away, ≈ USD 194/month" → New: "HA and Multi-AZ RDS, as the instructor said: a tfvars change away, ≈ USD 310/month"
- Not built. Old: "QuickSight not deployed; refunds on cancellation are promised in the email, not processed" → New: "No BI tool (QuickSight blocked on the AWS Free plan); reporting read replica; refunds promised in the email, not processed"
- Rough edges. Old: "Concert list not cached at CloudFront (/api/* uses CachingDisabled); API image still deployed by hand" → New: "Concert list not cached at CloudFront; API rollout manual (CI tests API, Lambda, Terraform); one task role shared by six services; scale-out 5.5–5.6 min → scheduled pre-scale; RDS Proxy"

## Page 24 — What to take away
- Card 1. Old: "use cases built, deployed and shown live on CloudFront" → New: "use cases on six ECS services, shown live on CloudFront"

## Q&A prep

- **"100k fans poll every 5 s against a 100 rps throttle: what happens?"** ≈ 20,000 req/s; today the excess gets 429
  and the page polls again (the place in DynamoDB is kept). Production: per-route throttles, Retry-After with
  jittered backoff, a raised API Gateway quota per on-sale, a public per-concert "admitted up to N" value cached at CloudFront (≈ 5 s) so pages compute their place locally; per-fan `/status` can't be cached (report §2.2).
- **"Scale-out never met 5 min. Why trust on-sale day?"** Measured 4.2–5.6 min to running tasks, so we don't rely on
  it: min 2 tasks per service (run 2: 0 errors) plus an `aws_appautoscaling_scheduled_action` raising the minimum
  before `sale_starts_at`; the waiting room caps buyers at 500 per concert per minute.
- **"130 connections vs ≈ 80 max: why no RDS Proxy?"** Dev never gets near it (one task per service; the connections
  alarm at 64 warns first). RDS Proxy is the named mitigation before production, with smaller pools as a fallback.
- **"Why 150/month against an 80 budget, and why not ARM64 or Spot?"** Six services × one task (+74 for tasks and
  IPs); we destroy after sessions, project total ≈ USD 58. Image is amd64 (ARM64 ≈ 20% cheaper, future); no Spot
  because an interrupted task mid-on-sale loses sales (reporting could use Spot).
- **"Is the shared task role least-privilege?"** No, and we say so: the Lambdas, Scheduler and GitHub Actions have
  their own roles, but the six API services share one; per-service task roles are the next step.
- **"Was AZ-loss or region-loss recovery exercised?"** No, both are design only (HA not deployed, per the
  instructor). Exercised: task loss (76 s outage) and point-in-time restore (RPO 2.8 min, RTO 9 min 14 s).
