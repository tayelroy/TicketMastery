# Cost estimate: dev stack

> **ESTIMATE ONLY.** On-demand list prices for **ap-southeast-1 (Singapore)** in USD, excluding tax. 730 hours/month, default `terraform.tfvars.example` settings, light dev/demo traffic. Prices change, so **check in the [AWS Pricing Calculator](https://calculator.aws/)** before relying on these numbers.

The defaults build the **implementation** mode agreed at the proposal feedback: one AZ, no NAT gateway, no HA (see [architecture.md](architecture.md#implementation-vs-target-ha-design)). The API runs as **6 ECS services** from one image (discovery, account, waiting-room, checkout, organiser, reporting), each with 1 task and its own autoscaling (instructor feedback b). The second table prices the **target HA design** that the diagram and report show.

## Implementation (default): monthly, if left running 24/7

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| Application Load Balancer | 1, ~1 LCU average | $0.0252/h + $0.008/LCU-h | 18.4 + 5.8 = 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, **single-AZ** (AZ a) | ≈ $0.025/h | 18.3 |
| RDS storage | 20 GB gp3 | ≈ $0.138/GB-month | 2.8 |
| ECS Fargate (Linux/x86) | 6 tasks (1 per service), each 0.25 vCPU / 0.5 GB | $0.05056/vCPU-h + $0.00553/GB-h: 0.25 × 0.05056 × 730 = 9.23 + 0.5 × 0.00553 × 730 = 2.02 → 11.25, ≈ 11.2 per task | 6 × 11.2 = 67.2 |
| Public IPv4 addresses | 1 per Fargate task (6). The ALB is internal (reached through the API Gateway VPC link), so it has no public IPs | $0.005/h each (≈ 3.65/month) | 6 × 3.65 = 21.9 |
| Secrets Manager | 2 secrets (RDS-managed master; `reporting/reporting-ro`) | $0.40/secret-month | 2 × 0.4 = 0.8 |
| CloudWatch Logs | ~1 GB ingested, 14-day retention | ingest + storage | ≈ 0.9 |
| ECR | < 1 GB of images | $0.10/GB-month | 0.1 |
| NAT gateway | none (`enable_nat_gateway = false`) | | 0 |
| **Total** | | | **≈ 136** |

Sum: 24.2 + 18.3 + 2.8 + 67.2 + 21.9 + 0.8 + 0.9 + 0.1 = 136.2, so **≈ USD 136/month**, about **USD 4.5 per day** or **USD 0.19 per hour**. Secrets Manager + CloudWatch Logs + ECR = 0.8 + 0.9 + 0.1 = **1.8** (used in every table). Before the split into six services (one task, one secret) the base stack was ≈ 62/month (≈ 2.0/day): the split adds 5 tasks × (11.2 + 3.65) = 74.25 plus 0.4 for the second secret (136.2 − 74.65 = 61.55).

The default before that (one private-subnet task behind one NAT gateway, public ALB) cost **≈ USD 110–115/month**. Dropping the NAT gateway removed ≈ 43.1 (hourly) + ≈ 0.3 (≈ 5 GB processed) + 3.65 (its Elastic IP); each task's own public IPv4 adds 3.65 back.

**NAT gateway price, for reference.** At the review the instructor put the NAT gateway at "$2 or something per AZ" plus traffic. That is about right **per day**: the ap-southeast-1 list price is **$0.059/h per NAT gateway**, ≈ USD 1.42/day, which comes to ≈ **USD 43/month per AZ**, plus **$0.059/GB** processed.

## Target HA design (for the report, not deployed)

Values from the commented "HA / target design" block in `terraform.tfvars.example`, at the autoscaling minimum of 2 tasks per service (one per AZ).

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| NAT gateways | 2 (one per AZ, `single_nat_gateway = false`) | $0.059/h each + $0.059/GB | 2 × 43.1 + ~0.3 = 86.5 |
| NAT Elastic IPs | 2 | $0.005/h each | 7.3 |
| Application Load Balancer | 1, ~1 LCU average | as above | 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, **Multi-AZ** | ≈ $0.050/h | 36.5 |
| RDS storage | 20 GB gp3, Multi-AZ | ≈ $0.276/GB-month | 5.5 |
| ECS Fargate | 6 services × 2 tasks minimum = 12 tasks, private subnets, no public IP | as above | 12 × 11.2 = 134.4 |
| Secrets Manager + CloudWatch Logs + ECR | as above | | ≈ 1.8 |
| **Total** | | | **≈ 296** |

Sum: 86.5 + 7.3 + 24.2 + 36.5 + 5.5 + 134.4 + 1.8 = 296.2, so **≈ USD 296/month**, about **USD 9.7 per day**. The ALB is internal here too, so it has no public IPs. Each extra task while a service is scaled out adds ≈ 11.2/month. Using `enable_vpc_endpoints = true` instead of the two NAT gateways would cost about the same (≈ USD 95/month for 5 endpoints × 2 AZs versus ≈ 94 for 2 NAT + 2 EIP).

## What moves the number

Relative to the implementation default (≈ USD 136/month):

| Change | Effect |
|---|---|
| `db_multi_az = true` | RDS instance + storage roughly **double**: +≈ USD 21 (≈ 42 for RDS in total). The AZ pin is dropped automatically. |
| Autoscaling above 1 task per service | Each extra task adds ≈ USD 11.2/month while it runs, **plus 3.65 for its public IPv4** while `tasks_in_public_subnets = true` |
| `cpu_architecture = "ARM64"` (Graviton, arm64 image) | Fargate ≈ 20% cheaper |
| `container_insights = "enabled"` | Extra CloudWatch custom metrics, a few USD/month |
| `enable_nat_gateway = true` (one NAT) | +≈ USD 43.1 + 3.65 (EIP) + $0.059/GB. Only useful with `tasks_in_public_subnets = false` or for in-VPC Lambdas. |
| `tasks_in_public_subnets = false` + one NAT | +≈ USD 25 net (NAT + EIP ≈ 46.8, minus 6 task public IPv4s ≈ 21.9) |
| `single_nat_gateway = false` (with NAT on) | Second NAT + EIP: +≈ USD 47 |
| `enable_vpc_endpoints = true` | ≈ $0.013/h per AZ per endpoint. 5 endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs) × 2 AZs ≈ **USD 95/month** plus $0.013/GB. Only needed for private-subnet tasks without NAT. |

## Saving money

1. **Destroy the stack when you aren't working on it or demoing** (`terraform destroy`, see [deploy.md](deploy.md#teardown)). This is by far the biggest saving: re-creating it takes about 15 minutes.
2. **NAT is off by default now.** Leave `enable_nat_gateway = false` unless tasks move to private subnets or an in-VPC Lambda needs internet/AWS-API egress. Keep Lambdas outside the VPC when they don't need RDS (see [architecture.md](architecture.md#lambdas-and-the-vpc-no-nat-by-default)).
3. Scale every service to 0 tasks (autoscaling minimum and maximum 0; `desired_count` is ignored after the service is created, because autoscaling owns it) to stop paying for Fargate while keeping everything else. That saves ≈ 11.2 + 3.65 = 14.85 per service, ≈ 89.1 for all six.
4. **Free tier** (only if the account is eligible; it depends on account age and plan): it may cover 750 h/month of a single-AZ RDS micro instance with 20 GB storage, and some ALB hours. Don't count on it until you've checked the account's Billing → Free tier page. The account is on the **AWS Free plan** with USD 123.33 of credits left on 6 Nov 2026 (they expire 2027-02-18).
5. The `monitoring` module's **AWS Budgets** budget (USD 80/month) emails `contact_email` at USD 20 / 40 / 60 / 80 actual spend and when the forecast passes USD 80. At the six-service run rate (≈ USD 4.9/day, ≈ 150/month whole stack) the forecast passes USD 80, so that alert is expected. Actual November spend should stay under it because the stack is destroyed after 10 Nov: ≈ 6 days × 2.5 (single-service stack) + ≈ 4 days × 4.9 ≈ **USD 35** (estimate). Total project spend (NFR-11): October USD 22.92 (measured) + November ≈ 35 ≈ **USD 58** (estimate), under USD 80.

## Rest of the deployed stack (edge, auth, waiting room, e-tickets, monitoring)

The tables above price the base stack. Everything else that `infra/envs/dev` deploys is mostly pay per request and
near zero at dev and demo traffic; the fixed costs are WAF, the CloudWatch alarms beyond the free tier and the dashboard. Prices are
ap-southeast-1 list prices, checked 2026-11-01: CloudWatch and API Gateway from the AWS Price List API
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonCloudWatch,AmazonApiGateway}/current/ap-southeast-1/index.json`),
Budgets from <https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/>, the CloudWatch free tier from
<https://aws.amazon.com/cloudwatch/pricing/>; the rest are ESTIMATES to check in the AWS Pricing Calculator.

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| WAF (on CloudFront) | 1 web ACL, 2 rules (AWS common rule set, IP rate limit) | $5/ACL + $1/rule + $0.60/M requests | 5 + 2 = 7.0 |
| CloudWatch alarms | 31 alarms = 44 standard-resolution alarm metrics: 26 single-metric alarms (12 per service, 3 RDS, 4 Lambda, ALB p95, API Gateway p95, `ticket-queue` age, join DLQ, `ticket-dlq`, waiting-room size, e-ticket delivery latency p95) + 3 two-metric rate alarms (ALB 5xx, API Gateway 5xx, checkout failures) + 2 `MAX` alarms over 6 services (ECS CPU, memory) | $0.10 per alarm metric; first 10 free | (44 − 10) × 0.10 = 3.4 (4.4 without the free tier) |
| CloudWatch custom metrics | 4: `WaitingRoomSize`, `ETicketDeliveryLatency` (EMF), checkout attempts / failures (log metric filters) | $0.30/metric for the first 10,000; first 10 free | 0 (1.2 without the free tier) |
| CloudWatch dashboard | 1 (`ticketmastery-dev`), 63 metrics | free only up to 50 metrics per dashboard, then $3/dashboard-month | 3.0 |
| AWS Budgets | 1 budget, notifications only (no actions) | free | 0 |
| API Gateway HTTP API | ≈ 100,000 requests (dev, demos, load tests) | $1.25 per million (first 300 M) | 0.1 |
| VPC link (HTTP API) | 1 | no charge for HTTP API VPC links | 0 |
| CloudFront + S3 site | < 10 GB out, < 1 M requests | free tier: 1 TB out + 10 M requests/month | 0 |
| Cognito | < 50 monthly active users | Essentials: 10,000 MAU free | 0 |
| Lambda `queue-manager` + `ticket-fn` | ≈ 44,000 scheduled admit runs + SQS-triggered runs | free tier: 1 M requests + 400,000 GB-s | 0 |
| EventBridge Scheduler | 1 schedule every minute ≈ 43,800 invocations | 14 M invocations/month free | 0 |
| SQS (2 queues + 2 DLQs) + SNS | < 1 M requests (long polling) | 1 M requests free | 0 |
| DynamoDB `live-queue` | on-demand, a few thousand reads/writes | pay per request | < 0.1 |
| SES | < 1,000 e-ticket emails (sandbox) | $0.10 per 1,000 + attachment data | < 0.1 |
| S3 e-ticket bucket | < 1 GB of PDFs | ≈ $0.025/GB-month | < 0.1 |
| **Total** | | | **≈ 14** |

Sum: 7.0 + 3.4 + 3.0 + 0.1 + ≈ 0.2 (DynamoDB, SES, S3) = 13.7.

So the whole deployed stack is **≈ USD 150/month** (136.2 + 13.7 = 149.9) if left running 24/7, about **USD 4.9/day**.
Before the split it was ≈ 62 + 13.7 ≈ 76/month (≈ 2.5/day; measured 2.02–2.26/day in October with lighter monitoring); the difference is mainly the five extra tasks and their public IPv4s (+74.25).
With the HA design it would be **≈ USD 310/month** (296.2 + 13.7 = 309.9), about **USD 10.2/day**.

Not deployed, so not counted: Route 53 (a hosted zone is USD 0.50/month), an RDS read replica for reporting (design
only), KMS customer-managed keys, CloudTrail beyond the free trail. QuickSight was removed: the account is on the AWS
Free plan, which can't subscribe to it (see [reporting.md](reporting.md)).
