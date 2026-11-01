# Cost estimate: dev stack

> **ESTIMATE ONLY.** On-demand list prices for **ap-southeast-1 (Singapore)** in USD, excluding tax. 730 hours/month, default `terraform.tfvars.example` settings, light dev/demo traffic. Prices change, so **check in the [AWS Pricing Calculator](https://calculator.aws/)** before relying on these numbers.

The defaults build the **implementation** mode agreed at the proposal feedback: one AZ, no NAT gateway, no HA (see [architecture.md](architecture.md#implementation-vs-target-ha-design)). The second table prices the **target HA design** that the diagram and report show.

## Implementation (default): monthly, if left running 24/7

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| Application Load Balancer | 1, ~1 LCU average | $0.0252/h + $0.008/LCU-h | 18.4 + 5.8 = 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, **single-AZ** (AZ a) | ≈ $0.025/h | 18.3 |
| RDS storage | 20 GB gp3 | ≈ $0.138/GB-month | 2.8 |
| ECS Fargate (Linux/x86) | 1 task, 0.25 vCPU / 0.5 GB | $0.05056/vCPU-h + $0.00553/GB-h | 9.2 + 2.0 = 11.3 |
| Public IPv4 addresses | Fargate task (1). The ALB is internal (reached through the API Gateway VPC link), so it has no public IPs | $0.005/h each (≈ 3.65/month) | 3.65 |
| Secrets Manager | 1 secret (RDS-managed master) | $0.40/secret-month | 0.4 |
| CloudWatch Logs | ~1 GB ingested, 14-day retention | ingest + storage | 0.7–1.0 |
| ECR | < 1 GB of images | $0.10/GB-month | 0.1 |
| NAT gateway | none (`enable_nat_gateway = false`) | | 0 |
| **Total** | | | **≈ 62** |

That works out to about **USD 2.0 per day** or **USD 0.085 per hour**. Until the ALB became internal (API Gateway VPC link, Oct 2026) its two public IPv4 addresses added ≈ 7.3, i.e. ≈ 69/month.

The previous default (private-subnet tasks behind one NAT gateway) cost **≈ USD 110–115/month**. Dropping the NAT gateway removes ≈ 43.1 (hourly) + ≈ 0.3 (≈ 5 GB processed) + 3.65 (its Elastic IP). The task's own public IPv4 adds 3.65 back.

**NAT gateway price, for reference.** At the review the instructor put the NAT gateway at "$2 or something per AZ" plus traffic. That is about right **per day**: the ap-southeast-1 list price is **$0.059/h per NAT gateway**, ≈ USD 1.42/day, which comes to ≈ **USD 43/month per AZ**, plus **$0.059/GB** processed.

## Target HA design (for the report, not deployed)

Values from the commented "HA / target design" block in `terraform.tfvars.example`, at the autoscaling minimum of 2 tasks.

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| NAT gateways | 2 (one per AZ, `single_nat_gateway = false`) | $0.059/h each + $0.059/GB | 2 × 43.1 + ~0.3 = 86.5 |
| NAT Elastic IPs | 2 | $0.005/h each | 7.3 |
| Application Load Balancer | 1, ~1 LCU average | as above | 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, **Multi-AZ** | ≈ $0.050/h | 36.6 |
| RDS storage | 20 GB gp3, Multi-AZ | ≈ $0.276/GB-month | 5.5 |
| ECS Fargate | 2 tasks minimum (one per AZ), private subnets, no public IP | as above | 2 × 11.3 = 22.6 |
| Secrets Manager + CloudWatch Logs + ECR | as above | | ≈ 1.5 |
| **Total** | | | **≈ 184** |

That is about **USD 6.1 per day**. The ALB is internal here too, so it has no public IPs. Each extra task while scaled out (up to `autoscaling_max_capacity = 4`) adds ≈ 11.3/month. Using `enable_vpc_endpoints = true` instead of the two NAT gateways would cost about the same (≈ USD 95/month for 5 endpoints × 2 AZs versus ≈ 94 for 2 NAT + 2 EIP).

## What moves the number

Relative to the implementation default (≈ USD 62/month):

| Change | Effect |
|---|---|
| `db_multi_az = true` | RDS instance + storage roughly **double**: +≈ USD 21 (≈ 42 for RDS in total). The AZ pin is dropped automatically. |
| `desired_count` / autoscaling above 1 task | Each extra task adds ≈ USD 11.3/month while it runs, **plus 3.65 for its public IPv4** while `tasks_in_public_subnets = true` |
| `cpu_architecture = "ARM64"` (Graviton, arm64 image) | Fargate ≈ 20% cheaper |
| `container_insights = "enabled"` | Extra CloudWatch custom metrics, a few USD/month |
| `enable_nat_gateway = true` (one NAT) | +≈ USD 43.1 + 3.65 (EIP) + $0.059/GB. Only useful with `tasks_in_public_subnets = false` or for in-VPC Lambdas. |
| `tasks_in_public_subnets = false` + one NAT | +≈ USD 43 net (NAT + EIP, minus the task's public IPv4) |
| `single_nat_gateway = false` (with NAT on) | Second NAT + EIP: +≈ USD 47 |
| `enable_vpc_endpoints = true` | ≈ $0.013/h per AZ per endpoint. 5 endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs) × 2 AZs ≈ **USD 95/month** plus $0.013/GB. Only needed for private-subnet tasks without NAT. |

## Saving money

1. **Destroy the stack when you aren't working on it or demoing** (`terraform destroy`, see [deploy.md](deploy.md#teardown)). This is by far the biggest saving: re-creating it takes about 15 minutes.
2. **NAT is off by default now.** Leave `enable_nat_gateway = false` unless tasks move to private subnets or an in-VPC Lambda needs internet/AWS-API egress. Keep Lambdas outside the VPC when they don't need RDS (see [architecture.md](architecture.md#lambdas-and-the-vpc-no-nat-by-default)).
3. Set `desired_count = 0` to stop paying for Fargate while keeping everything else. That saves ≈ 11.3 + 3.65 (the task's public IPv4).
4. **Free tier** (only if the account is eligible; it depends on account age and plan): it may cover 750 h/month of a single-AZ RDS micro instance with 20 GB storage, and some ALB hours. Don't count on it until you've checked the account's Billing → Free tier page.
5. The `monitoring` module's **AWS Budgets** budget (USD 80/month) emails `contact_email` at USD 20 / 40 / 60 / 80 actual spend and when the forecast passes USD 80.

## Rest of the deployed stack (edge, auth, waiting room, e-tickets, monitoring)

The tables above price the base stack. Everything else that `infra/envs/dev` deploys is mostly pay per request and
near zero at dev and demo traffic; the fixed costs are WAF and the CloudWatch alarms beyond the free tier. Prices are
ap-southeast-1 list prices, checked 2026-11-01: CloudWatch and API Gateway from the AWS Price List API
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonCloudWatch,AmazonApiGateway}/current/ap-southeast-1/index.json`),
Budgets from <https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/>, the CloudWatch free tier from
<https://aws.amazon.com/cloudwatch/pricing/>; the rest are ESTIMATES to check in the AWS Pricing Calculator.

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| WAF (on CloudFront) | 1 web ACL, 3 rules | $5/ACL + $1/rule + $0.60/M requests | 8.0 |
| CloudWatch alarms | 23 standard-resolution alarm metrics (15 single-metric alarms + 3 two-metric rate alarms in `monitoring`, 4 Lambda alarms, the `ticket-dlq` alarm); 24 with autoscaling on | $0.10 per alarm metric; first 10 free | 1.3 (2.3 without the free tier) |
| CloudWatch custom metrics | 4: `WaitingRoomSize`, `ETicketDeliveryLatency` (EMF), checkout attempts / failures (log metric filters) | $0.30/metric for the first 10,000; first 10 free | 0 (1.2 without the free tier) |
| CloudWatch dashboard | 1 (`ticketmastery-dev`) | first 3 dashboards free, then per dashboard | 0 |
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
| **Total** | | | **≈ 10** |

So the whole deployed stack is **≈ USD 72/month** (≈ 62 base + ≈ 10) if left running 24/7, about **USD 2.4/day**.
With the HA design it would be ≈ USD 194/month.

Not deployed, so not counted: Route 53 (a hosted zone is USD 0.50/month), QuickSight (per user per month; design
only, see [reporting.md](reporting.md)), KMS customer-managed keys, CloudTrail beyond the free trail.
