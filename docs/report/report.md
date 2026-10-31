---
title: "TicketMastery: concert ticketing on AWS"
subtitle: "IS458 Cloud Management and Engineering, final report"
author: "Cody, Andrew, Nai Xin, Yan Ting, Shi Hui, Elroy"
date: "10 November 2026"
---

<!-- Draft. Numbers come from the repo docs and the proposal; anything we still have to measure is marked
     EVIDENCE or MONITORING in an HTML comment. Export: pandoc report.md -o report.docx / report.pdf. -->

# 1. Executive summary

TicketMastery is a Singapore-based B2C platform where fans across Asia-Pacific buy concert tickets. It falls under the
course's *Online Shopping System* theme. Ticket sales are spiky: a popular on-sale can bring 50,000–100,000 concurrent
fans in its first minutes, about 10× normal load. The platform must stay up during that spike and must never sell a
seat twice.

We built it on AWS in ap-southeast-1 (Singapore). CloudFront and WAF serve the static React app from S3 and pass
`/api/*` to an API Gateway HTTP API. API Gateway checks Cognito tokens and reaches an internal Application Load
Balancer through a VPC link. Behind the ALB, one ECS Fargate service (`ticketmastery-api`) hosts all five use cases
and stores concerts, seats and orders in RDS PostgreSQL. Two pieces run outside the request path:

- **Virtual waiting room:** SQS FIFO, DynamoDB and the `queue-manager` Lambda on an EventBridge schedule. It admits
  fans in batches, so the spike never reaches the database at once.
- **E-ticket pipeline:** SNS → SQS → the `ticket-fn` Lambda → S3 and SES. It takes PDF rendering and email off the
  checkout path.

**Zero double-booking** comes from one rule: a seat hold is a single all-or-nothing `UPDATE` in the same database as
the seats and orders.

The report shows two designs:

- **Target high-availability (HA) design:** two AZs, private subnets with a NAT gateway per AZ, autoscaling 2–4+
  tasks, Multi-AZ RDS. It would cost about USD 190/month.
- **Implementation mode:** what the instructor asked us to deploy at the proposal review. One AZ, no NAT gateway, one
  task, single-AZ RDS, about USD 69/month for the base stack.

Both designs come from the same Terraform; a block of variables switches between them. Section 3 shows both
diagrams. Section 7 says which availability targets are therefore design-only.

Operations are managed as code:

- Terraform modules with shared S3 remote state and locking.
- GitHub Actions for the frontend.
- CODEOWNERS-based review.
- CloudWatch alarms and a dashboard that email through SNS.
- AWS Budgets at USD 20/40/60/80.

# 2. Business context and requirements

## 2.1 Business context and goal

TicketMastery serves three kinds of user (Google Doc, *Customer Base*):

- **Guests** browse concerts without signing in.
- **Fans** (registered users) join waiting rooms, buy tickets and download e-tickets.
- **Organisers** (internal staff, Cognito group `organisers`) create concerts, ticket types and seat layouts, and
  watch sales live.

Business goal (Google Doc): fans buy tickets *"without the platform buckling under traffic spikes, with every seat
sold to exactly one buyer"*, checkout stays secure, e-tickets arrive within seconds, and organisers see pricing,
inventory and sales in real time.

## 2.2 Base requirement and traffic model

The specification's base requirement for the Online Shopping System theme is: *the company covers Asia-Pacific; 80%
of its customers are from Singapore; the remainder are split evenly between Malaysia, Thailand and Hong Kong.*

During the proposal we drafted a different split (Google Doc, *Traffic model and APAC split*): Singapore 60%,
Malaysia 20%, Indonesia/Thailand/Philippines 15%, rest of APAC 5%. It was labelled "team assumption, to confirm".
**This report uses the specification's split**, because it is the base requirement we are assessed against:

| Origin | Share of customers | How it is served |
|---|---|---|
| Singapore | 80% | CloudFront edge in Singapore; API in ap-southeast-1 |
| Malaysia | ≈ 6.7% | CloudFront edge; dynamic calls on the AWS backbone to Singapore |
| Thailand | ≈ 6.7% | CloudFront edge; as above |
| Hong Kong | ≈ 6.7% | CloudFront edge; as above |

The design conclusion is the same under either split. With most demand in Singapore, one region (ap-southeast-1) and
CloudFront edges for the rest of APAC are enough. The earlier serverless write-up estimated round trips from
Singapore of about 10 ms to Kuala Lumpur and 30–40 ms to Bangkok and Hong Kong. That is well inside the 300 ms p95
target (NFR-1). The distribution uses `PriceClass_200` (`infra/modules/edge`), which includes edge locations in all
four markets.

Load assumptions for one major on-sale (Google Doc):

| Phase | Concurrent users | Absorbed by |
|---|---|---|
| Normal day | ≈ 5,000 | CloudFront for static content; ALB + minimum task count for the API |
| First 10 minutes of a major on-sale | 50,000–100,000 | Waiting room (SQS FIFO + DynamoDB); CloudFront serves the waiting page; fans are admitted in batches of 500 per minute |

## 2.3 Use cases

The proposal listed ten fan use cases, two admin and six system use cases (Google Doc). We grouped them into five
deliverable use cases. Each one is a module in the API and a folder in the frontend:

| UC | Name | Covers (proposal use cases) | Owner |
|---|---|---|---|
| UC1 | Concert discovery | Browse, search and filter concerts; concert details; seat map | Cody, Nai Xin |
| UC2 | My Tickets & Account | Register, sign in and out; order history; view and download e-tickets | Andrew |
| UC3 | Virtual waiting room | Join the queue, live position, batch admission, admission expiry | Yan Ting |
| UC4 | Seat selection & checkout | Hold seats for 10 min; simulated payment; confirm; e-ticket by email | Shi Hui |
| UC5 | Concert & ticket management | Create, edit, publish and cancel concerts; ticket types, prices, layouts; live dashboard; reporting | Elroy |

The system use cases (autoscaling, flash-sale queue, monitoring, caching, load balancing, failure handling) are
covered in Sections 7 and 8.

## 2.4 Functional requirements

| # | Requirement | UC |
|---|---|---|
| FR-1 | List upcoming published concerts with search (`q`, artist, venue) and date filters; show details, ticket types, prices and availability | UC1 |
| FR-2 | Show the seat map with available, held and sold seats; holds that have expired show as available | UC1 / UC4 |
| FR-3 | Sign up, sign in and sign out with Cognito (email verification); organisers are a Cognito group | UC2 |
| FR-4 | List the fan's confirmed orders and open any e-ticket; download its PDF through a short-lived link | UC2 |
| FR-5 | Join a concert's waiting room, see the queue position, and be admitted in arrival order in batches | UC3 |
| FR-6 | Only admitted fans may hold seats; admission expires after 15 minutes | UC3 / UC4 |
| FR-7 | Hold 1–20 seats for 10 minutes, all or nothing; at most one active hold per fan per concert | UC4 |
| FR-8 | Simulate payment success or failure; success sells the seats and confirms the order; failure or timeout releases them | UC4 |
| FR-9 | Email the e-ticket PDF after payment, exactly once per order | UC4 |
| FR-10 | Organisers create draft concerts, set ticket types and the seat layout, publish, and cancel (also after the sale opens); the layout locks once the sale opens | UC5 |
| FR-11 | Organisers see live available, held and sold counts and revenue per ticket type | UC5 |
| FR-12 | Sales reporting by concert, ticket type and day for a BI tool | UC5 |

Payment goes through a simulated gateway (the proposal scoped real payment as design-only; see Section 12).

## 2.5 Non-functional requirements

The NFR table below is the one from the proposal (Google Doc). The last column says how each one is evidenced in this
report.

| # | Category | Target | Evidence (Section 10) |
|---|---|---|---|
| NFR-1 | Performance | Browse and seat-map APIs: p95 < 300 ms, p99 < 800 ms at baseline | k6 browse test; ALB `TargetResponseTime` |
| NFR-2 | Scalability | Sustain 10× baseline; scale-out within 5 min; 0 dropped requests at the admitted rate | k6 burst test with autoscaling enabled for the run; ECS scaling activity |
| NFR-3 | Correctness | 0 oversold seats across all tests | Concurrent hold test + SQL check: no seat in two confirmed orders |
| NFR-4 | Hold accuracy | Seat available again within 30 s of hold expiry | Hold-expiry script + DB check |
| NFR-5 | Availability | 99.9% monthly for the purchase path; no outage on the loss of one instance or one AZ | Instance loss: drill F1. AZ loss: design-only in implementation mode (Section 7) |
| NFR-6 | Fairness | Admission order matches queue order | Waiting-room log comparison |
| NFR-7 | Delivery | 95% of e-ticket emails sent within 60 s of payment | SQS `ApproximateAgeOfOldestMessage`, `ticket-fn` logs, SES metrics |
| NFR-8 | RPO | Paid orders: 0 on AZ loss; ≤ 30 min on data corruption; ≤ 24 h on region loss | RDS point-in-time restore drill F4; AZ and region loss are design-only |
| NFR-9 | RTO | AZ loss ≤ 5 min; data corruption ≤ 1 h; region loss ≤ 4 h (design only) | Drills F1 and F4 |
| NFR-10 | Security | HTTPS everywhere; encryption at rest; DB only in private subnets | Configuration review (Section 9.5) |
| NFR-11 | Cost | Total project spend under USD 80 | AWS Budgets and the billing console |

# 3. Architecture

## 3.1 From the serverless proposal to containers and RDS

Our first write-up was all-serverless: API Gateway REST and WebSocket APIs, one Lambda per module, and DynamoDB for
concerts, seats and orders, with conditional writes and `TransactWriteItems` for seat locking. We kept the parts of
its reasoning that still hold:

- one region with CloudFront for APAC;
- a WAF in front of a single public entry point;
- SQS FIFO for the queue;
- SNS/SQS fan-out for e-tickets with idempotent consumers;
- Cognito.

We moved the core to **ECS Fargate + RDS PostgreSQL** for four reasons:

1. **Correctness is easier to prove in SQL.** A seat hold is one `UPDATE … WHERE status = 'available' OR (held and
   expired)` with a row-count check. Seats, ticket types and orders sit in one database. Confirming a payment, cancelling
   a concert and freezing the layout are each one transaction, guarded by foreign keys, check constraints and triggers.
   In DynamoDB the same guarantees need careful single-table design. `TransactWriteItems` is limited to 100 items per
   transaction, and organiser reporting would need a second store or exports.
2. **Organiser reporting is relational.** Sales by concert, ticket type and day are SQL views that a BI tool
   (QuickSight) reads directly.
3. **It covers more of the course.** A VPC with public and private subnets, security-group chaining, a load balancer,
   container autoscaling and Multi-AZ failover are central topics. The serverless design had nothing to put in a VPC.
4. **The cost is predictable** at our scale (Section 4), and one API language (TypeScript) is shared with the
   frontend.

We kept serverless where it fits best: the waiting room (DynamoDB scales with the spike without loading the single
database; this was also the instructor's suggestion, Section 11) and the asynchronous e-ticket worker.

The trade-off: ECS and RDS cost money while idle and scale more slowly than Lambda. The waiting room (Section 6.2) is
what makes that acceptable, because it caps the request rate that reaches the API.

## 3.2 Target HA design

![Figure 1. Target HA architecture (design; source `figures/target-ha-architecture.mmd`).](figures/target-ha-architecture.png){width=62%}

- **Edge.** Route 53 → CloudFront (`PriceClass_200`, HTTPS redirect) with a WAF web ACL (AWS managed common rule set +
  a rate-based rule at 2,000 requests per 5 minutes per IP). Static content comes from a private S3 bucket through
  Origin Access Control. `/api/*` and `/health` go to API Gateway.
- **API front door.** API Gateway HTTP API. Public routes (`GET /api/concerts…`, `GET /health`) need no token. All
  other `/api/*` routes need a Cognito access token (JWT authorizer). The stage has throttling (100 rps steady, 200
  burst) and JSON access logs. A **VPC link** reaches an **internal** ALB, so the ALB is never internet-facing.
- **Compute.** One ECS Fargate service, `ticketmastery-api` (Node 20, Express, TypeScript). It runs at least 2 tasks,
  one per AZ, in **private** subnets. Autoscaling uses CPU and ALB request-count target tracking. Egress to ECR,
  CloudWatch Logs, Secrets Manager and Cognito goes through a NAT gateway per AZ (or VPC interface endpoints).
- **Data.** RDS PostgreSQL 16 **Multi-AZ** (synchronous standby, automatic failover), 7-day backups with
  point-in-time restore, deletion protection, encrypted storage. The master password is managed by RDS in Secrets
  Manager.
- **Waiting room.** SQS FIFO `join-queue` → `queue-manager` (Python) → DynamoDB `live-queue`. EventBridge Scheduler
  runs it every minute during the sale window.
- **E-tickets.** SNS `order-events` → SQS `ticket-queue` (DLQ after 5 failures) → `ticket-fn` (Node 20, outside the
  VPC) → S3 `tickets/<orderId>.pdf` + SES email.
- **Operations.** CloudWatch alarms and a dashboard, SNS `alerts` to email, AWS Budgets. QuickSight with a VPC
  connection to RDS for reporting (design-only, Section 12).

## 3.3 Implementation mode (deployed)

At the proposal review the instructor asked us to **skip the NAT gateway, use one AZ, and not implement HA, but still
show the HA design** (`docs/architecture.md`, *Implementation vs target (HA) design*). The Terraform defaults build
that:

![Figure 2. Deployed implementation (source `figures/implementation-architecture.mmd`).](figures/implementation-architecture.png){width=58%}

| Aspect | Implementation (deployed) | Target HA | Variable(s) |
|---|---|---|---|
| Task subnets | AZ a public subnet, public IP for egress only | Private subnets in AZ a + b | `tasks_in_public_subnets`, `tasks_single_az` |
| Task egress | Own public IP via the internet gateway | NAT per AZ or interface endpoints | `enable_nat_gateway`, `single_nat_gateway`, `enable_vpc_endpoints` |
| Task count / scaling | 1 task, autoscaling off | ≥ 2 tasks, autoscaling 2–4+ | `desired_count`, `enable_autoscaling`, `autoscaling_min/max_capacity` |
| Database | Single-AZ, pinned to AZ a, 1-day backups | Multi-AZ, 7-day backups, deletion protection | `db_multi_az`, `db_backup_retention_period`, `db_deletion_protection` |
| Cost (estimate) | ≈ USD 69/month | ≈ USD 190/month | `docs/cost-estimate.md` |

Two design points are specific to this mode:

- **The task's public IP is not an open door.** The task security group has exactly one ingress rule: the container
  port, from the ALB security group. The public IP is used only for outbound calls. RDS stays in private subnets with
  `publicly_accessible = false`.
- **Lambdas and the VPC.** A Lambda attached to a VPC never gets a public IP, so with no NAT it can reach only what the
  free S3 and DynamoDB **gateway endpoints** cover. So `ticket-fn` runs outside the VPC (it needs SQS, S3, SES and
  Cognito). `queue-manager` runs in the private subnets. Its SQS input arrives through an event source mapping (the
  Lambda service polls the queue), and it writes DynamoDB through the gateway endpoint. It publishes its metric as a
  structured log line (CloudWatch Embedded Metric Format), because it cannot call the CloudWatch API (Section 8).

Two public and two private subnets still exist: an ALB needs two AZs, and an RDS subnet group must span two AZs. In
implementation mode only the second ALB node and an empty DB-subnet-group member sit in AZ b.

# 4. Resource allocation and justification

Sizing follows the implementation mode. Monthly costs are on-demand list prices for ap-southeast-1, 730 h/month,
taken from `docs/cost-estimate.md` (estimates, not bills).

| Layer | Service and configuration | Why this service | Why this size | ≈ USD/month |
|---|---|---|---|---|
| Edge | CloudFront `PriceClass_200`; SPA cache policy (default TTL 1 day, max 1 year; hashed assets immutable) | Edges in SG, MY, TH and HK; TLS close to fans; absorbs browse traffic | Price class 200 is the cheapest class that covers all four markets | pay per request |
| Edge security | WAF web ACL: AWS common rule set + IP rate limit 2,000 / 5 min | Blocks common exploits and simple floods before they reach the API | One ACL, two rules | ≈ 5 + 1 per rule (fixed) |
| Static site | S3 private bucket + OAC | Static SPA, no servers | n/a | < 1 |
| Identity | Cognito user pool, `organisers` group, email verification | Managed sign-up and sign-in, JWTs that API Gateway validates | n/a | free tier |
| API front door | API Gateway HTTP API, JWT authorizer, VPC link, 100 rps / 200 burst throttle | Central API management (instructor feedback a); auth before compute; HTTP API's VPC link supports an ALB directly (REST would need an extra NLB, ≈ USD 18+/month) | Throttle sized to protect one 0.25 vCPU task | pay per request |
| Load balancer | Internal ALB, health check `/health` (DB `SELECT 1`) | Spreads requests over tasks and AZs; removes unhealthy tasks | 1 ALB | 24.2 |
| Compute | ECS Fargate, 1 task × 0.25 vCPU / 0.5 GB, x86_64; autoscaling (off in implementation) CPU 60% and 500 requests per task per minute targets | No servers to patch; per-second billing; scales by task | Smallest Fargate size; enough for demo traffic; the burst test (NFR-2) checks the scaled size | 11.3 |
| Public IPv4 | 2 for the ALB + 1 for the task | Replaces a NAT gateway (≈ 43/month per AZ) | n/a | 10.95 |
| Database | RDS PostgreSQL 16 `db.t4g.micro`, 20 GB gp3, encrypted, single-AZ (Multi-AZ in target) | Transactions for zero double-booking; relational reporting | Smallest Graviton class; data fits easily in 20 GB | 18.3 + 2.8 |
| Secrets | Secrets Manager (RDS-managed master secret) | Password never in code or state | 1 secret | 0.4 |
| Registry | ECR, scan on push, keep last 10 images | Private images for Fargate | < 1 GB | 0.1 |
| Logs | CloudWatch Logs, 14-day retention | Central logs for API, API Gateway and Lambdas | ≈ 1 GB | 0.7–1.0 |
| Waiting room | SQS FIFO `join-queue` (+ DLQ after 3), DynamoDB `live-queue`, `queue-manager` Python 3.13, 128 MB, 30 s timeout, batch 10; EventBridge Scheduler every minute in the sale window | FIFO keeps arrival order per concert; DynamoDB scales with the spike without loading RDS | One schedule ≈ 43,800 runs/month, inside the 14 M free tier | ≈ 0 |
| E-tickets | SNS `order-events` → SQS `ticket-queue` (visibility 6× the Lambda timeout, DLQ after 5, 14-day DLQ retention) → `ticket-fn` (Node 20, outside the VPC) → private S3 + SES | Async: checkout doesn't wait for PDF or email; retries and DLQ are built in | Pay per message | ≈ 0 |
| Monitoring | CloudWatch alarms + dashboard, SNS `alerts` email, AWS Budgets | Section 8 | <!-- MONITORING: alarm count and dashboard cost from modules/monitoring README --> | <!-- MONITORING: from modules/monitoring README --> |
| **Base stack total** | | | | **≈ 69** (≈ 2.3/day) |

The target HA design costs **≈ USD 190/month** (≈ 6.3/day). Most of the difference is two NAT gateways and their
Elastic IPs (≈ 94), Multi-AZ RDS (≈ +21) and a second task (≈ +11). The appendix has the line items.

Choices we considered and rejected:

- **NAT gateway vs public-subnet task:** at ≈ USD 43/month per AZ, a NAT gateway would have been the largest single
  line item. Following the instructor's advice, implementation mode uses the task's public IP instead.
- **ElastiCache for seat holds** (in the proposal): rejected. A hold in Redis plus an order in RDS is two systems that
  can disagree. One SQL `UPDATE` cannot.
- **Interface endpoints instead of NAT:** about the same price for 5 endpoints × 2 AZs (≈ USD 95 vs ≈ 94), so either
  works in the HA design.
- **QuickSight:** billed per user per month, so it is design-only (Section 12).

# 5. Linkage of resources

## 5.1 Request path per use case

| UC | Path |
|---|---|
| All (static) | Browser → CloudFront (+ WAF) → S3 via OAC; `index.html` rewritten for SPA routes by a CloudFront function |
| UC1 | Browser → CloudFront `/api/concerts…` → API Gateway public route → VPC link → ALB → Fargate `discovery` module → RDS (read) |
| UC2 | Browser → Cognito Hosted UI or SDK (sign in, access token) → CloudFront → API Gateway (JWT authorizer) → ALB → `account` module → RDS (orders); download: API → S3 `GetObject` pre-signed URL (300 s) → browser fetches the PDF from S3 |
| UC3 | `POST /join` → API → SQS FIFO (`MessageGroupId = concertId`) → `queue-manager` → DynamoDB `live-queue`; `GET /status` → API → DynamoDB `GetItem`; EventBridge Scheduler → `queue-manager` admits batches |
| UC4 | `POST /api/checkout/holds` → API → DynamoDB (is the fan admitted?) → RDS transaction; `POST …/confirm` → RDS transaction → SNS `order-events` → SQS `ticket-queue` → `ticket-fn` → Cognito (fan's email by `sub`) → S3 `tickets/<orderId>.pdf` → SES |
| UC5 | Organiser → API Gateway (JWT) → `organiser` module (checks the `organisers` group) → RDS; dashboard polled every 5 s |

![Figure 3. On-sale purchase sequence (source `figures/purchase-sequence.mmd`).](figures/purchase-sequence.png)

## 5.2 Events

| Producer | Channel | Consumer | Message | Delivery guarantee and failure handling |
|---|---|---|---|---|
| API (UC3 join) | SQS FIFO `join-queue` | `queue-manager` | `{ eventId, userId, joinedAt }`; group = concert, dedup = hash of `userId#concertId` | Ordered per concert; duplicates within 5 min dropped; DLQ after 3 tries |
| EventBridge Scheduler | Schedule (1 min, sale window) | `queue-manager` | Scheduled event | At-least-once; admitting is idempotent (status change only from `WAITING`) |
| API (UC4 confirm) | SNS `order-events` → SQS `ticket-queue` | `ticket-fn` | `OrderConfirmed` | At-least-once; partial batch failures; DLQ after 5; S3 write with `If-None-Match: *` so a retry never emails twice |
| `queue-manager` | CloudWatch Logs (Embedded Metric Format) | CloudWatch metric `TicketMastery/WaitingRoomSize` | JSON log line per run | Feeds the waiting-room alarm |
| CloudWatch alarms, Budgets | SNS `alerts` | Email | Alarm and budget notifications | Section 8 |

## 5.3 IAM

Each component has its own role with least-privilege inline policies. Modules attach their policies to the API task
role by name, so access is granted by the module that owns the resource:

| Principal | Allowed | Granted by |
|---|---|---|
| ECS execution role | Pull from ECR, write its log group, read the RDS master secret | `ecs-service` |
| API task role | `sqs:SendMessage` on `join-queue`; DynamoDB read on `live-queue`; `sns:Publish` on `order-events`; `s3:GetObject` on `tickets/*` and `s3:ListBucket` on the e-ticket bucket | `waiting-room`, `messaging` |
| `queue-manager` role | Receive/delete on `join-queue`; read/write `live-queue`; VPC ENI management; logs | `waiting-room` |
| `ticket-fn` role | Receive/delete on `ticket-queue`; `s3:PutObject` on `tickets/*`; SES send from the verified identity; Cognito user lookup; logs | `messaging` |
| GitHub Actions deploy role | OIDC-federated (no stored keys); sync the frontend bucket and invalidate the distribution | `github-deploy` |
| API Gateway | VPC link to the internal ALB only | `auth-apigw` |

## 5.4 Network

- **Security groups chain:** VPC-link SG → `alb_sg` (port 80) → `ecs_sg` (container port only) → `rds_sg` (5432
  only, plus `rds_extra_ingress_sg_ids` for in-VPC Lambdas that need RDS).
- **Routing:** public subnets route to the internet gateway. Private subnets have no internet route in implementation
  mode; they carry the free S3 and DynamoDB gateway endpoints. In the HA design they route through a NAT gateway per
  AZ.
- **TLS:** CloudFront terminates HTTPS (`redirect-to-https`) and calls API Gateway over HTTPS (TLS 1.2). The API
  connects to RDS with `DB_SSL=true`.

# 6. Implementation per use case and key mechanisms

## 6.1 Code structure

One service, five modules (`src/modules/<uc>/`: `router.ts`, `service.ts`, `repository.ts`, `schemas.ts`). Each use
case owns its own migrations (`NNNN_<uc>_<desc>.sql`), and modules don't import each other. Migrations run at task
start under a Postgres advisory lock, so tasks that start together are safe, and a failed migration is rolled back
by the ECS deployment circuit breaker. `/health` checks the database for the ALB; `/health/live` does not, so a
database blip doesn't kill every task. The frontend mirrors the same split (`frontend/src/pages/<uc>/`).

## 6.2 UC3: virtual waiting room

1. A signed-in fan calls `POST /api/waiting-room/:concertId/join`. The API sends the join to SQS FIFO with
   `MessageGroupId = concertId`, so joins for one concert are processed in arrival order, and a deduplication ID of
   `hash(userId#concertId)`, so double-clicks don't create two entries. A fan who is already queued keeps their
   number.
2. `queue-manager` consumes the joins (batch 10) and writes each fan to DynamoDB `live-queue` with the next position
   (`WAITING`).
3. Every minute during the sale window, EventBridge Scheduler invokes `queue-manager`. It admits the next **500
   `WAITING` fans per concert** (`ADMITTED`, 15-minute expiry). On every scheduled run it also emits the
   waiting-room size metric.
4. The browser polls `GET /status` and gets `pending`, `waiting` (with `peopleAhead`), `admitted` (with
   `admittedUntil`) or `expired`.
5. Checkout's `isAdmitted` reads `live-queue`. A fan who isn't admitted gets `403 not_admitted` when trying to hold
   seats.

The batch size caps the load that reaches the API and RDS at about 500 new buyers per concert per minute, however
large the crowd. That cap is the main reason one small task and a micro database can survive an on-sale.

## 6.3 UC4: all-or-nothing seat hold

The canonical statement (`src/db/seat-holds.ts`) runs in one transaction with the creation of the `pending` order:

```sql
UPDATE seats
   SET status = 'held', held_by = $3, hold_id = $4,
       held_at = now(), hold_expires_at = now() + make_interval(mins => 10)
 WHERE concert_id = $1
   AND id = ANY($2::uuid[])
   AND (status = 'available' OR (status = 'held' AND hold_expires_at < now()))
RETURNING id;
```

If fewer rows come back than seats were requested, the transaction rolls back and the API returns `409
seats_unavailable` with the seats that were taken, so nothing is half-held. Postgres row locks serialise overlapping
holds; the seat IDs are sorted first, so overlapping holds lock in the same order, which avoids deadlocks. Expired
holds are reclaimed by the same predicate, so no sweeper is needed for correctness. The rules:

- prices are fixed when the hold is taken;
- at most one active hold per fan per concert (`409 active_hold_exists`);
- a ticket type's `max_per_order` is enforced;
- the sale window and concert status are checked (`409 not_on_sale`).

Confirming (simulated payment) moves the seats `held → sold` only if the hold is the fan's and hasn't expired, and
marks the order `confirmed` in the same transaction. It then publishes `OrderConfirmed`. Payment failure, timeout or
a concert cancellation release the seats and close the order as `cancelled` or `expired`. The integration test
`test/seat-inventory.test.ts` runs two concurrent holds on the same seats against real Postgres and asserts that
exactly one wins.

Why Postgres and not DynamoDB for holds (instructor feedback c): the hold, the order and the seat status must change
together. In one database that is a local transaction; split across two stores it would need a saga with
compensations.

## 6.4 UC4/UC2: e-ticket pipeline

`ticket-fn` (Node 20, outside the VPC) consumes `ticket-queue` and reports partial batch failures, so one bad message
doesn't retry the whole batch. For each order it:

1. renders the PDF;
2. writes `tickets/<orderId>.pdf` with `If-None-Match: *`. If the object already exists, a previous attempt has
   already sent the email, so the retry stops: **at most one email per order**;
3. looks up the fan's email in Cognito by `sub`;
4. sends the email with the PDF through SES.

After 5 failures a message moves to `ticket-dlq` (14-day retention for inspection and re-drive), which raises an
alarm. In UC2, `GET /api/me/tickets/:id/download` returns a 300-second pre-signed S3 URL, or `409 ticket_not_ready`
until the PDF exists. SES runs in the sandbox, so only verified recipients receive mail; production access is a
go-live step (Section 12).

<!-- EVIDENCE: confirm ticket-fn details against lambdas/ticket-fn/README.md once merged (runtime, timeout, PDF library). -->

## 6.5 UC5: organiser management and dashboard

- **Create and edit.** Organisers (Cognito group `organisers`, checked by the API) create draft concerts, replace
  ticket types and replace the whole seat layout in one transaction.
- **Publish.** Publishing needs ticket types and a matching layout.
- **Layout lock.** Once the sale opens, the layout is locked by the service (`SELECT … FOR UPDATE`, `409
  layout_locked`) and by database triggers for any other writer.
- **Cancel.** Cancelling is allowed even after the lock; pending holds then fail with `409 concert_cancelled`.
- **Live dashboard.** `GET /api/organiser/concerts/:id/dashboard` returns available, held and sold counts and revenue
  per ticket type (`Cache-Control: no-store`). The page polls it every 5 s.
- **Reporting.** Migration `0003_uc5_reporting_views.sql` adds views for sales by concert, ticket type and day, and
  seat-status counts. Any BI tool can read them; QuickSight is the design (Section 12).

## 6.6 UC1 and UC2

- **UC1.** Discovery is public. It lists published concerts with search, filters and pagination, shows detail with
  per-type availability, and serves the seat map. The list is sent with `Cache-Control: public, max-age=60` and the
  detail with `max-age=15`. The seat map is `no-store`, because availability changes every second.
- **UC2.** Account returns the caller's confirmed orders (newest first), single tickets and the download link. To stop
  order IDs being probed, another fan's order answers `404`, the same as a missing one.
- **Auth.** The API verifies the Cognito access token a second time (signature, issuer, expiry, `token_use`, client
  ID), so a misconfigured route can't bypass authorisation.

# 7. Scalability and availability

## 7.1 Scaling mechanisms

| Mechanism | Setting | Effect |
|---|---|---|
| CloudFront | SPA cached at the edge (1 day; hashed assets 1 year); deploys invalidate `/*` | Browsing and the waiting page cost the origin almost nothing |
| API caching | Discovery list `max-age=60`, detail `max-age=15`; seat map, checkout and dashboard `no-store` | Static data is cacheable; fast-changing data is never cached (Google Doc, system UC4). The CloudFront `/api/*` behaviour currently uses `CachingDisabled`, so these headers only take effect in browsers; caching `GET /api/concerts*` at the edge is listed in Section 12 |
| Waiting room | 500 admissions per concert per minute; 15-min admission window | Turns a 50,000–100,000-fan spike into a bounded stream of buyers |
| API Gateway throttling | 100 rps steady, 200 burst | Sheds excess load with `429` before it reaches the task |
| WAF rate rule | 2,000 requests / 5 min per IP | Blocks single-source floods and bots |
| ECS autoscaling (target design; on for the burst test) | Target tracking: average CPU 60%, ALB requests per target 500/min; min 2, max 4+ | Adds tasks during the admitted surge, removes them afterwards |
| DynamoDB, SQS, SNS, Lambda | Managed, scale per request | The spike-facing parts have no capacity to plan |
| RDS | `db.t4g.micro`; `DB_POOL_MAX` 10 per task, so tasks × 10 stays below `max_connections` | Vertical scaling (larger class) is the next step; read replicas for reporting |

## 7.2 Availability: target vs implementation

| Failure | Target HA design | Implementation mode | Evidence |
|---|---|---|---|
| F1: one task fails | ALB health check removes it; other AZ's tasks serve; ECS replaces it | ECS replaces the only task; outage until it is healthy | <!-- EVIDENCE: F1 drill, stop the ECS task and time until /health is 200 again --> |
| F2: AZ a lost | Tasks in AZ b serve; RDS fails over to the standby (typically 60–120 s, no committed data lost) | Full outage until the AZ recovers or a restore in AZ b | Design-only |
| F3: bad deployment | Circuit breaker rolls back to the last good task definition | Same | ECS deployment events |
| F4: data corruption | Point-in-time restore to a new instance (7-day window) | Same, 1-day window | <!-- EVIDENCE: F4 drill, RDS point-in-time restore duration and restore point --> |
| F5: `ticket-fn` failing | Retries, then DLQ + alarm; orders are already confirmed in RDS, so a ticket can be re-driven later | Same | <!-- EVIDENCE: DLQ alarm email screenshot (forced alarm) --> |
| F6: region lost | Restore from snapshot in another region (design: cross-region snapshot copy); RTO ≤ 4 h, RPO ≤ 24 h | Not covered | Design-only |

NFR-5 (99.9% and surviving an AZ loss) is therefore a target-design claim. In implementation mode the instructor
accepted a single AZ, and AZ a is a single point of failure for the API and the database. The ALB, API Gateway,
CloudFront, S3, DynamoDB, SQS, SNS and Lambda are regional or global managed services and are multi-AZ in both
modes.

# 8. Monitoring and alerts

All monitoring is in Terraform (`infra/modules/monitoring`). Alarms and AWS Budgets notify the SNS topic `alerts`,
which emails the team (`tayelroy@gmail.com`). Every row of the proposal's monitoring table that applies to the
built stack has an alarm. Two proposal rows were adapted: the ASG and ElastiCache rows became ECS and RDS rows,
because we run Fargate and no Redis.

| Signal | Metric | Alarm when | Proposal row / NFR |
|---|---|---|---|
| API latency | ALB `TargetResponseTime` p95 | > 300 ms <!-- MONITORING: evaluation periods from modules/monitoring README --> | API latency / NFR-1 |
| API errors | ALB `HTTPCode_Target_5XX_Count` vs `RequestCount` | 5xx > 1% <!-- MONITORING: period from modules/monitoring README --> | API errors |
| Gateway errors | API Gateway `5xx` | <!-- MONITORING: threshold from modules/monitoring README --> | API errors |
| Task health | ALB `UnHealthyHostCount` | Any unhealthy host <!-- MONITORING: duration from modules/monitoring README --> | Instance health / NFR-5 |
| Compute load | ECS `CPUUtilization`, `MemoryUtilization` | <!-- MONITORING: thresholds from modules/monitoring README --> | Scaling headroom |
| Database load | RDS `CPUUtilization`, `DatabaseConnections`, `FreeStorageSpace` | CPU > 75%; <!-- MONITORING: connection and storage thresholds from modules/monitoring README --> | Database load |
| Waiting room | `TicketMastery/WaitingRoomSize` (from `queue-manager`, Embedded Metric Format) | <!-- MONITORING: threshold from modules/monitoring README (proposal: 20,000) --> | Waiting room size / NFR-6 |
| E-ticket backlog | SQS `ApproximateAgeOfOldestMessage` on `ticket-queue` | > 60 s | E-ticket backlog / NFR-7 |
| E-ticket failures | `ticket-dlq` visible messages | > 0 | E-ticket backlog / NFR-7 |
| Lambda errors | `Errors` for `queue-manager` and `ticket-fn` | <!-- MONITORING: threshold from modules/monitoring README --> | Application health |
| Budget | AWS Budgets, monthly cost | Spend crosses USD 20, 40, 60, 80 | Budget / NFR-11 |

The proposal's "checkout failures %" row is not built, because payment is simulated. Section 12 has the design.

**Why an Embedded Metric Format (EMF) log line for the waiting-room metric:** `queue-manager` runs in the VPC without
NAT, so it cannot call `PutMetricData`. It prints one JSON line per run in Embedded Metric Format, and CloudWatch Logs
turns it into a metric at no API cost.

**Dashboard.** One CloudWatch dashboard with:

- the four golden signals for the API (latency, traffic, errors, saturation);
- RDS CPU and connections;
- waiting-room size;
- `ticket-queue` age and DLQ depth;
- Lambda errors.

<!-- MONITORING: dashboard name and widget list from modules/monitoring README -->
<!-- EVIDENCE: dashboard screenshot during the burst test -->

**Alert test.** To prove delivery end to end, one alarm is forced into `ALARM` with `aws cloudwatch set-alarm-state`
and the email is checked.
<!-- EVIDENCE: which alarm was forced, time sent vs time received, screenshot of the email -->

# 9. Management approach

## 9.1 Infrastructure as code and remote state

- **Modules.** All infrastructure is Terraform (≥ 1.10, AWS provider ~> 5.0). One root module (`infra/envs/dev`)
  wires one module per area:

  | Module | Owner |
  |---|---|
  | `network`, `security`, `ecr`, `rds`, `ecs-service` | Elroy |
  | `edge` | Cody |
  | `auth-apigw` | Andrew |
  | `waiting-room` | Yan Ting |
  | `messaging` | Shi Hui |
  | `github-deploy`, `monitoring` | Elroy |

- **Module conventions.**
  - Shared values are passed in as variables, not looked up.
  - Resource names are prefixed with `ticketmastery-dev`.
  - Each module grants the API its own least-privilege policy.
  - Non-secret configuration reaches the API through `extra_environment`.
  - Secrets come from Secrets Manager at runtime.
- **Remote state.** State is in S3 (`ticketmastery-tfstate-000246635159`, versioned) with S3-native locking, so only
  one apply runs at a time and everyone sees the same state.
- **Switching modes.** One `tfvars` block switches between implementation and HA mode (Section 3.3). `check` blocks
  and preconditions catch invalid combinations, for example private-subnet tasks without egress, or Multi-AZ with an
  AZ pin.
- **Change process.** Every change is `plan -out` → review → `apply` of that plan, announced to the team first.

## 9.2 CI/CD

- **Frontend CI** (`.github/workflows/frontend.yml`) type-checks and builds on pull requests.
- **Deploy Frontend to AWS** (`deploy-frontend.yml`, manual, `main` only) builds the SPA, syncs it to S3 and
  invalidates CloudFront. It assumes an IAM role through GitHub OIDC, so no AWS keys are stored in GitHub.
- **The API image** is built for `linux/amd64`, tagged with the git SHA, pushed to ECR (scanned on push) and rolled
  out by Terraform or `update-service --force-new-deployment`. The deployment circuit breaker rolls back failures.
- **The API test suite** runs against a real Postgres: seat-hold concurrency, layout-lock triggers, auth and config.
  Coverage must be 100% for `src/auth`, `src/config.ts` and `src/modules/account`.

## 9.3 Branching, ownership and review

- **Branching.** Trunk-based on `main` with short-lived feature branches and Conventional Commit titles (`CONTRIBUTING.md`).
- **Ownership.** `.github/CODEOWNERS` maps every path to its owner (per module, per migration use-case tag, per Lambda).
  Every PR needs an approving review from the code owner of each path it touches.
- **PR template.** Asks for:
  - type and touched areas;
  - how the change was tested;
  - a checklist: rebased, no secrets or `tfvars`/`tfstate`, no edits to merged migrations, `terraform fmt`/`validate`
    pass, team told before any apply, docs updated.
- **Merging.** Feature PRs are squash-merged. The final integration branch is merged with a merge commit so every
  teammate keeps authorship.

## 9.4 Cost management

- **Implementation mode by default:** no NAT gateway, single AZ, one task. That brings the base stack from ≈ USD
  110–115 (with one NAT gateway) to ≈ 69/month (`docs/cost-estimate.md`).
- **Teardown:** `terraform destroy` after demos and work sessions. Re-creating the stack takes about 15 minutes.
  Dev defaults make the destroy clean: no final snapshot, no deletion protection, ECR force-delete.
- **Budget:** AWS Budgets alerts at USD 20/40/60/80 against the USD 80 project budget (NFR-11).
- **Schedules:** EventBridge schedules are limited to the sale window (instructor feedback d).
- **Pay-per-request where usage is idle most of the time:** waiting room, e-tickets, API Gateway.

<!-- EVIDENCE: actual spend to date from Billing / Cost Explorer, and the Budgets screenshot -->

## 9.5 Security

| Layer | Control |
|---|---|
| Edge | HTTPS only (CloudFront redirect); WAF managed common rules + IP rate limit; S3 reachable only via OAC |
| Identity | Cognito with email verification; organisers as a group; JWT checked by API Gateway and again by the API |
| Network | Internal ALB reached only through the VPC link; SG chain VPC link → ALB → task → RDS; RDS private, not publicly accessible |
| Data | RDS storage encrypted; TLS to the DB; e-ticket bucket private, accessed through 300 s pre-signed URLs; S3 bucket public access blocked |
| Secrets | DB password generated and stored by RDS in Secrets Manager; injected as ECS secrets; nothing in code, `tfvars` or state |
| CI | GitHub OIDC role scoped to the frontend bucket and distribution |
| App | zod validation of all input; error bodies never expose internals; dev-header auth refused in production unless explicitly allowed |

Gaps we accept for dev (production steps in Section 12):

- Cognito MFA is off (target: optional TOTP).
- Deletion protection is off so `terraform destroy` works.
- SES is in the sandbox.

## 9.6 Backup, disaster recovery, RPO and RTO

| Scenario | Mechanism | RPO target (NFR-8) | RTO target (NFR-9) | Implementation status |
|---|---|---|---|---|
| Task loss | ECS replaces the task; ALB health check | n/a | ≤ 5 min | Drill F1 <!-- EVIDENCE: measured F1 recovery time --> |
| AZ loss | Multi-AZ RDS synchronous standby; tasks in AZ b | 0 | ≤ 5 min | Design-only |
| Data corruption | RDS automated backups + point-in-time restore to a new instance | ≤ 30 min (PITR restores to within about 5 minutes) | ≤ 1 h | Drill F4 <!-- EVIDENCE: measured F4 restore time and achieved restore point --> |
| Region loss | Cross-region snapshot copy + Terraform re-apply in another region | ≤ 24 h | ≤ 4 h | Design-only |
| Lost e-ticket | Order in RDS is the source of truth; DLQ re-drive regenerates it | 0 | Minutes | DLQ alarm |

Terraform state is versioned in S3, and every resource can be recreated from code, so infrastructure itself has no
backup beyond the repository and the state bucket.

## 9.7 Teardown

`terraform destroy` removes the stack (`docs/deploy.md`, *Teardown*). Afterwards we check for things that keep
billing: leftover ENIs from in-VPC Lambdas, unattached Elastic IPs, log groups created outside Terraform, manual
snapshots, and secrets in their recovery window. The state bucket and the Budgets alerts are kept.

# 10. Evidence

The evidence files are in `docs/report/evidence/`. The k6 scripts are in `loadtest/`. For the load tests the WAF
rate rule allowed the test IP, and autoscaling (max 3) was on only for the burst test.

| NFR | Test | Result | Pass? |
|---|---|---|---|
| NFR-1 | k6 browse (`GET /api/concerts`, detail, seat map) at baseline | p95 <!-- EVIDENCE: k6 p95 ms --> ms, p99 <!-- EVIDENCE: k6 p99 ms --> ms; ALB `TargetResponseTime` p95 <!-- EVIDENCE: CloudWatch p95 --> | <!-- EVIDENCE: pass/fail --> |
| NFR-2 | k6 10× burst, autoscaling on (max 3) | Peak rps <!-- EVIDENCE: peak rps -->, tasks 1 → <!-- EVIDENCE: max tasks --> in <!-- EVIDENCE: scale-out time from ECS events --> min, dropped requests at the admitted rate <!-- EVIDENCE: count of non-429 errors --> | <!-- EVIDENCE: pass/fail --> |
| NFR-3 | Many fans racing for the same seats + SQL check for any seat in two confirmed orders | Hold attempts <!-- EVIDENCE: number -->, successful holds <!-- EVIDENCE: number -->, oversold seats <!-- EVIDENCE: SQL result (expect 0) --> | <!-- EVIDENCE: pass/fail --> |
| NFR-4 | Hold, wait 10 min, re-hold the seats | Seat available again after <!-- EVIDENCE: seconds after expiry --> s | <!-- EVIDENCE: pass/fail --> |
| NFR-5 | F1: stop the only ECS task | API back after <!-- EVIDENCE: seconds until /health 200 --> s; AZ loss design-only | <!-- EVIDENCE: pass/fail for instance loss --> |
| NFR-6 | Join N fans in order, compare admission order | <!-- EVIDENCE: N and number of order mismatches (expect 0) --> | <!-- EVIDENCE: pass/fail --> |
| NFR-7 | Purchases → e-ticket email | Max `ApproximateAgeOfOldestMessage` <!-- EVIDENCE: seconds -->; p95 payment-to-send <!-- EVIDENCE: seconds from ticket-fn logs --> | <!-- EVIDENCE: pass/fail --> |
| NFR-8/9 | F4: RDS point-in-time restore | Restore point <!-- EVIDENCE: restore point vs latest restorable time -->, restore duration <!-- EVIDENCE: minutes --> | <!-- EVIDENCE: pass/fail --> |
| NFR-10 | Configuration review | HTTPS redirect, RDS `StorageEncrypted`, `PubliclyAccessible = false`, internal ALB | <!-- EVIDENCE: describe-db-instances / describe-load-balancers output --> |
| NFR-11 | Spend vs USD 80 | <!-- EVIDENCE: total spend to date (USD) --> | <!-- EVIDENCE: pass/fail --> |

Functional evidence (screenshots on the CloudFront URL):

1. UC1 browse;
2. UC3 waiting room, queued and then admitted;
3. UC4 hold with countdown, then confirm;
4. UC2 My Tickets, PDF download, and the e-ticket email;
5. UC5 create → publish → live dashboard → cancel;
6. reporting views returning the demo concert's sales.

<!-- EVIDENCE: list the screenshot file names per item above -->

Monitoring evidence: the dashboard during the burst test and the forced-alarm email (Section 8).
<!-- EVIDENCE: file names -->

# 11. Instructor feedback and our response

| # | Feedback at the proposal review | Our response | Status |
|---|---|---|---|
| — | Use public subnets to avoid the NAT gateway, one AZ, no HA for the implementation, but show HA in the diagram | Implementation mode as Terraform defaults; HA design behind variables, shown in Figure 1 with its cost | Done |
| a | Put API Gateway in front of Fargate so all APIs are managed centrally | HTTP API with Cognito JWT authorizer, throttling, access logs and a VPC link to an internal ALB (option B, chosen over a public ALB with a secret header) | Done |
| b | Consider per-feature containers so each part scales on its own | We kept one service but split it into one module per use case, with per-UC migrations and no cross-module imports. Splitting later means one ECS service per module behind ALB path rules (e.g. `/api/concerts*`). A monolith scales as one unit; with the waiting room capping the checkout load, that is acceptable at our scale | Design trade-off, Section 12 |
| c | DynamoDB is the usual store for dynamic session data (queue numbers, 10-minute holds) | The live queue is in DynamoDB. Seat holds stay in Postgres on purpose: one atomic `UPDATE` beside the seats and orders is what guarantees no double-booking (Section 6.3) | Done, justified |
| d | EventBridge every minute costs money; check it | ≈ 43,800 invocations/month, inside the Scheduler free tier (14 M), and limited to the sale window anyway | Done |
| e | UC5 needs internal reporting, e.g. QuickSight | The live dashboard plus SQL reporting views in RDS. QuickSight with a VPC connection is designed, not deployed, because of per-user billing (Section 12) | Partly done |

# 12. Limitations and future work

- **QuickSight (design only).** Design:
  - QuickSight (Enterprise) with a VPC connection into the private subnets; its security group is added to
    `rds_extra_ingress_sg_ids`.
  - A read-only DB user, with access only to the reporting views.
  - Dashboards for sales by concert, ticket type and day, sell-through, and seat status.

  Not deployed because QuickSight is billed per user per month, which doesn't fit a USD 80 budget. The reporting
  views make it a console-only step later.
- **HA not deployed.** AZ-loss tolerance, Multi-AZ RDS and autoscaling are design-only except for the burst test.
  Turning them on is a `tfvars` change (≈ USD 190/month).
- **Multi-region.** Not justified with 80% of customers in Singapore. The risk is that two regions could each sell
  the same seat unless writes stay in one region. Next step: cross-region snapshot copy for region-loss DR. The
  Malaysia (ap-southeast-5), Thailand (ap-southeast-7) and Hong Kong (ap-east-1) regions are future expansion or DR
  targets.
- **Edge caching of the concert list.** Add a CloudFront behaviour for `GET /api/concerts*` that honours the API's
  `max-age`, so browsing during an on-sale never reaches the origin.
- **Per-feature services** (feedback b) once traffic justifies separate scaling. Adaptive batch size: shrink the
  admission batch while latency or error alarms are firing.
- **Real payments.** Stripe, with an idempotency key per order and a signature-verified webhook. Checkout-failure-rate
  alarm (the proposal's checkout-failures row).
- **Production readiness:**
  - SES production access;
  - Cognito MFA;
  - deletion protection and 7-day backups;
  - custom domain with ACM certificates;
  - bot and scalper protection (WAF Bot Control, CAPTCHA at join);
  - push updates (WebSocket) instead of polling;
  - multi-currency pricing for MY, TH and HK.
- **API CI/CD.** The API image is built and deployed by hand. Next step: a GitHub Actions workflow that tests, builds,
  pushes to ECR and updates the service.

# Appendix A. API list

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /health` | public | Readiness (DB `SELECT 1`), used by the ALB |
| `GET /health/live` | public (not routed by API Gateway) | Liveness, no DB |
| `GET /api/concerts` | public | List and search published concerts (`q`, `artist`, `venue`, `from`, `to`, `limit`, `offset`) |
| `GET /api/concerts/:id` | public | Concert detail with ticket types and availability |
| `GET /api/concerts/:id/seats` | public | Seat map with `available`, `held`, `sold` |
| `GET /api/me` | fan | Caller's `sub` and groups |
| `GET /api/me/orders` | fan | Confirmed orders, newest first |
| `GET /api/me/tickets/:ticketId` | fan | One order |
| `GET /api/me/tickets/:ticketId/download` | fan | Pre-signed PDF URL (300 s) |
| `POST /api/waiting-room/:concertId/join` | fan | Join the queue |
| `GET /api/waiting-room/:concertId/status` | fan | Position and state |
| `GET /api/checkout/concerts/:concertId/seats` | fan | Seat map plus the fan's active hold |
| `POST /api/checkout/holds` | fan, admitted | Hold 1–20 seats for 10 minutes |
| `DELETE /api/checkout/holds/:holdId` | fan | Release a hold |
| `POST /api/checkout/holds/:holdId/confirm` | fan | Simulated payment; confirm the order |
| `POST /api/organiser/concerts` | organiser | Create a draft concert |
| `GET /api/organiser/concerts` | organiser | List my concerts |
| `GET /api/organiser/concerts/:id` | organiser | Detail with counts |
| `PUT /api/organiser/concerts/:id/ticket-types` | organiser | Replace ticket types |
| `PUT /api/organiser/concerts/:id/layout` | organiser | Replace the seat layout (one transaction) |
| `POST /api/organiser/concerts/:id/publish` | organiser | `draft` → `scheduled` |
| `POST /api/organiser/concerts/:id/cancel` | organiser | Cancel with a reason |
| `GET /api/organiser/concerts/:id/dashboard` | organiser | Live counts and revenue |

Errors are JSON `{ "error": { "code", "message", "details?" } }`: 400 validation, 401 no user, 403 not allowed or not
admitted, 404 unknown, 409 conflict (seats taken, hold expired, layout locked).

# Appendix B. Cost tables

Source: `docs/cost-estimate.md`. On-demand list prices, ap-southeast-1, USD, 730 h/month, excluding tax; estimates.

**Implementation mode (deployed defaults), if left running 24/7**

| Item | Assumption | ≈ USD/month |
|---|---|---|
| Application Load Balancer | 1, ~1 LCU average | 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, single-AZ | 18.3 |
| RDS storage | 20 GB gp3 | 2.8 |
| ECS Fargate | 1 task, 0.25 vCPU / 0.5 GB | 11.3 |
| Public IPv4 | ALB × 2 + task × 1 | 10.95 |
| Secrets Manager | 1 secret | 0.4 |
| CloudWatch Logs | ~1 GB, 14-day retention | 0.7–1.0 |
| ECR | < 1 GB | 0.1 |
| NAT gateway | none | 0 |
| **Total** | | **≈ 69** (≈ 2.3/day) |

**Target HA design (not deployed), at the minimum of 2 tasks**

| Item | Assumption | ≈ USD/month |
|---|---|---|
| NAT gateways | 2 (one per AZ) | 86.5 |
| NAT Elastic IPs | 2 | 7.3 |
| Application Load Balancer | 1 | 24.2 |
| ALB public IPv4 | 2 | 7.3 |
| RDS PostgreSQL | `db.t4g.micro`, Multi-AZ | 36.6 |
| RDS storage | 20 GB gp3, Multi-AZ | 5.5 |
| ECS Fargate | 2 tasks, private subnets | 22.6 |
| Secrets Manager + Logs + ECR | | ≈ 1.5 |
| **Total** | | **≈ 190** (≈ 6.3/day) |

**Outside the base-stack estimate:**

- WAF: ≈ USD 5/month per web ACL + 1 per rule, a fixed cost.
- Route 53 hosted zone: USD 0.50/month.
- CloudFront, S3, API Gateway, Cognito, Lambda, SQS, SNS, DynamoDB, EventBridge Scheduler and SES: pay per request,
  near zero at dev traffic.
- QuickSight: per user, not deployed.

<!-- EVIDENCE: actual monthly bill / Cost Explorer breakdown to compare with the estimate -->
