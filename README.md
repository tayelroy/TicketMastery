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
Organisers (verified via a Cognito group) create and manage concerts, ticket types, and seat layouts. A dashboard refreshes every 5s with live sold/held/available counts and revenue, backed by QuickSight reporting.

## Architecture

Deployed in the **ap-southeast-1 (Singapore)** region across two Availability Zones.

**Edge & routing**
- Route 53 (DNS) → CloudFront + WAF (edge cache, bot filtering) → API Gateway

**Compute**
- ECS Fargate service `ticketmastery-api` in private subnets across AZ A & AZ B, behind an Application Load Balancer. This single service hosts the API routes for all five use cases (UC1–UC5) under `/api/...`, one module per use case. It auto-scales on CPU and request count, and failed tasks are replaced automatically.

**Database**
- Amazon RDS PostgreSQL stores concerts, venues, seats, and orders. It is **single-AZ by default**. The professor confirmed single-AZ is fine for this project. A Terraform toggle (`db_multi_az`) turns on Multi-AZ, which adds a synchronous standby in the second AZ with automatic failover. Automated backups with point-in-time restore are enabled either way.

**Serverless & messaging**
- SQS FIFO (`join-queue`) + Lambda (`queue-manager`) for the waiting room
- DynamoDB for live queue state and admission tokens
- SNS → SQS → Lambda (`ticket-fn`) → SES for e-ticket delivery (with a dead-letter queue so no order is lost)
- EventBridge Scheduler to admit batches and release expired holds
- S3 for site files and e-ticket PDFs

**Auth, security & monitoring**
- Amazon Cognito (JWT auth, user pools, organiser groups)
- `X-Origin-Verify` secret header between API Gateway and the ALB
- IAM, KMS, CloudTrail, CloudWatch, AWS Budgets

## Availability Strategy

| Layer | Strategy |
|-------|----------|
| **Compute** | ECS Fargate across 2 AZs; failed tasks auto-replaced, ALB routes around them |
| **Database** | RDS single-AZ by default, with automated backups and point-in-time restore. An outage in the database's AZ means DB downtime until AWS recovers or we restore into the other AZ; RTO is TBC. Setting `db_multi_az = true` adds a synchronous standby with automatic failover. See [docs/architecture.md](docs/architecture.md#decision-single-az-rds). |
| **Serverless** | SQS/SNS/Lambda/S3/SES Multi-AZ by default; SQS retries then routes to a DLQ |

## Tech Stack

AWS (ECS Fargate, RDS PostgreSQL, DynamoDB, Lambda, SQS, SNS, SES, S3, Cognito, CloudFront, API Gateway, Route 53, WAF, EventBridge, QuickSight, CloudWatch, KMS, IAM)

## Repository layout

```
.
├── infra/                      Terraform: envs/dev root + modules (network, security, ecr, rds, ecs-service, + teammates' modules)
├── services/
│   └── ticketmastery-api/      Node 20 + Express + TypeScript API (ECS Fargate); modules per use case, SQL migrations
├── frontend/                   static SPA (S3 + CloudFront); placeholder
├── lambdas/                    queue-manager (UC3), ticket-fn (UC4); placeholders
├── docs/                       architecture, deploy guide, cost estimate
├── .github/                    CODEOWNERS, PR template
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
- [docs/architecture.md](docs/architecture.md): current design, diagram, decisions, open questions
- [docs/deploy.md](docs/deploy.md): deploying and tearing down the AWS dev stack
- [docs/cost-estimate.md](docs/cost-estimate.md): what the dev stack costs per month
- [infra/README.md](infra/README.md): Terraform modules, inputs, and outputs

## Team

Group 4

---

*Note: Payment processing is simulated in this build.*
