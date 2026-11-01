# TicketMastery

A cloud-native, Singapore-based B2C concert ticketing platform built on AWS. Fans browse upcoming concerts, pick their seats, check out, and receive e-tickets — all online, and all designed to stay up during high-demand on-sales.

## The Problem

Concert ticketing demand is spiky, not steady. A popular on-sale can drive **50,000–100,000+ concurrent users** in the opening minutes — roughly **10× normal load**. TicketMastery is designed to handle that spike while guaranteeing every seat is sold to exactly one buyer.

## Business Goals

- **Stay up during on-sale spikes** — auto-scaling and a virtual waiting room keep the platform from buckling under sudden surges.
- **Every seat sold to exactly one buyer** — seats are held for 10 minutes during checkout, with zero double-booking.
- **Secure, trustworthy checkout** — all traffic over HTTPS, data encrypted, database kept in private subnets.
- **Fast delivery** — e-tickets arrive within seconds of a successful payment.
- **Real-time control for organisers** — live visibility into pricing, inventory, and sales.

## User Types

- **Guest browsers** — browse, search, and filter concerts without logging in.
- **Registered users (fans)** — buy tickets, view orders, manage their profile.
- **Event organisers / admins** — create, edit, and cancel concerts; monitor live sales.

## Core Features

### 1. Concert Discovery
Browse, search, and filter upcoming concerts — no login required. Concert pages show artist, date/time, venue, ticket categories, prices, and a live seat map. Cached at the edge for sub-300ms responses on 95% of requests, even at peak.

### 2. My Tickets & Account
Fans register/sign in via Cognito to view e-tickets (order ID, concert, seats, date) and order history. Each fan sees only their own tickets; e-ticket PDFs are stored privately in S3 with 5-minute expiring download links.

### 3. Virtual Waiting Room
On high-demand sales, fans join a FIFO queue and receive a live queue number (first-come-first-served). Fans are admitted in controlled batches of 500/minute to prevent overload.

### 4. Seat Selection & Checkout
Fans pick seats on the seat map; seats are held for 10 minutes in an all-or-nothing RDS transaction. Simulated payment on success confirms the order, marks seats SOLD, and triggers e-ticket generation. Expired/failed holds release seats back to the pool.

### 5. Organiser Management
Organisers (verified via a Cognito group) create and manage concerts, ticket types, and seat layouts. A dashboard refreshes every 5s with live sold/held/available counts and revenue. Sales reporting views in RDS feed internal reports; a QuickSight dashboard on them is designed but not deployed (per-user pricing).

## Architecture

Designed for the **ap-southeast-1 (Singapore)** region across two Availability Zones. The sections below describe that **target (HA) design**. The deployed build is a single-AZ implementation of it; see [Implementation vs target (HA) design](#implementation-vs-target-ha-design).

**Edge & routing**
- Route 53 (DNS, target design; the deployed build uses the CloudFront domain) → CloudFront + WAF (edge cache, bot filtering) → API Gateway HTTP API (Cognito JWT authorizer) → VPC link → internal ALB

**Compute**
- ECS Fargate service `ticketmastery-api` behind an Application Load Balancer. This single service hosts the API routes for all five use cases (UC1–UC5) under `/api/...`, one module per use case. In the target design it runs in private subnets across AZ A & AZ B, auto-scales on CPU and request count, and failed tasks are replaced automatically.

**Database**
- Amazon RDS PostgreSQL stores concerts, venues, seats, and orders. The target design is **Multi-AZ** (synchronous standby in the second AZ with automatic failover). The deployed build is **single-AZ** (the professor confirmed that's fine for this project); a Terraform toggle (`db_multi_az`) turns on Multi-AZ. Automated backups with point-in-time restore are enabled either way.

**Serverless & messaging**
- SQS FIFO (`join-queue`) + Lambda (`queue-manager`) for the waiting room
- DynamoDB for live queue numbers and admissions
- SNS → SQS → Lambda (`ticket-fn`) → S3 + SES for e-ticket delivery (with a dead-letter queue so no order is lost)
- EventBridge Scheduler runs `queue-manager` every minute to admit the next batch of fans (expired seat holds need no job: checkout reclaims them atomically)
- S3 for site files and e-ticket PDFs

**Auth, security & monitoring**
- Amazon Cognito (JWT auth, user pools, organiser groups)
- API Gateway reaches the ALB only through a VPC link; the ALB is internal, with no public entry
- IAM least-privilege roles per service, encryption at rest (RDS, S3, SQS), CloudWatch alarms + dashboard with email alerts through SNS, AWS Budgets

## Implementation vs target (HA) design

At the proposal feedback (Oct 2026) the instructor told us to skip the NAT gateway, use one AZ, and not implement HA for the build, but the diagram and report must still show the HA design. The Terraform defaults therefore build the **implementation**; the HA values are one commented block in `infra/envs/dev/terraform.tfvars.example`.

| | Implementation (deployed by default) | Target HA (diagram + report) |
|---|---|---|
| Compute | 1 Fargate task in the AZ a public subnet with a public IP (inbound only from the ALB), no NAT gateway, autoscaling off | Tasks in private subnets across 2 AZs, NAT gateway per AZ (or VPC endpoints), autoscaling on CPU and request count |
| Database | RDS single-AZ, pinned to AZ a. An AZ a outage means downtime until AWS recovers or we restore elsewhere; RTO is TBC | RDS Multi-AZ, automatic failover |
| Serverless | SQS/SNS/Lambda/S3/SES are Multi-AZ by default; SQS retries then routes to a DLQ | Same |
| Cost (estimate, whole stack) | ≈ USD 72/month | ≈ USD 194/month |

Details, the variables to flip, and why two subnets of each kind still exist: [docs/architecture.md](docs/architecture.md#implementation-vs-target-ha-design).

## Tech Stack

AWS (ECS Fargate, RDS PostgreSQL, DynamoDB, Lambda, SQS, SNS, SES, S3, Cognito, CloudFront, API Gateway, WAF, EventBridge Scheduler, CloudWatch, AWS Budgets, IAM); Terraform; Node.js + TypeScript (API, `ticket-fn`), Python (`queue-manager`), React + Vite (frontend). Designed but not deployed: Route 53, QuickSight, KMS customer-managed keys.

## Repository layout

```
.
├── infra/                      Terraform: envs/dev root + modules (network, security, ecr, rds, ecs-service, edge, github-deploy, auth-apigw, waiting-room, messaging, monitoring)
├── services/
│   └── ticketmastery-api/      Node 20 + Express + TypeScript API (ECS Fargate); modules per use case, SQL migrations
├── frontend/                   React SPA (S3 + CloudFront), one page folder per use case
├── lambdas/                    queue-manager (UC3, Python), ticket-fn (UC4, Node.js)
├── loadtest/                   k6 scripts and drills that produce the NFR evidence
├── docs/                       architecture, deploy guide, cost estimate, reporting, final report (docs/report/)
├── .github/                    CODEOWNERS, PR template, frontend CI + deploy workflows
└── CONTRIBUTING.md             workflow, ownership, how to add routes / tables / Terraform
```

## Getting started

Run the API locally (needs Docker):

```bash
cd services/ticketmastery-api
docker compose up --build
curl http://localhost:3000/health
```

- [CONTRIBUTING.md](CONTRIBUTING.md): branches, reviews, ownership, adding routes, tables, and Terraform, secrets rules
- [docs/architecture.md](docs/architecture.md): current design, diagram, decisions, instructor feedback
- [docs/deploy.md](docs/deploy.md): deploying and tearing down the AWS dev stack
- [docs/cost-estimate.md](docs/cost-estimate.md): what the dev stack costs per month
- [infra/README.md](infra/README.md): Terraform modules, inputs, and outputs

## Team

Group 4

---

*Note: Payment processing is simulated in this build.*
