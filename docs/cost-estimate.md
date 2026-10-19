# Cost estimate: base stack (dev)

> **ESTIMATE ONLY.** On-demand list prices for **ap-southeast-1 (Singapore)** in USD, excluding tax. 730 hours/month, default `terraform.tfvars.example` settings, light dev/demo traffic. Prices change, so **check in the [AWS Pricing Calculator](https://calculator.aws/)** before relying on these numbers.

The defaults build the **implementation** mode agreed at the proposal feedback: one AZ, no NAT gateway, no HA (see [architecture.md](architecture.md#implementation-vs-target-ha-design)). The second table prices the **target HA design** that the diagram and report show.

## Implementation (default): monthly, if left running 24/7

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| Application Load Balancer | 1, ~1 LCU average | $0.0252/h + $0.008/LCU-h | 18.4 + 5.8 = 24.2 |
| RDS PostgreSQL | `db.t4g.micro`, **single-AZ** (AZ a) | ≈ $0.025/h | 18.3 |
| RDS storage | 20 GB gp3 | ≈ $0.138/GB-month | 2.8 |
| ECS Fargate (Linux/x86) | 1 task, 0.25 vCPU / 0.5 GB | $0.05056/vCPU-h + $0.00553/GB-h | 9.2 + 2.0 = 11.3 |
| Public IPv4 addresses | ALB (2, one per AZ) + Fargate task (1) | $0.005/h each (≈ 3.65/month) | 3 × 3.65 = 10.95 |
| Secrets Manager | 1 secret (RDS-managed master) | $0.40/secret-month | 0.4 |
| CloudWatch Logs | ~1 GB ingested, 14-day retention | ingest + storage | 0.7–1.0 |
| ECR | < 1 GB of images | $0.10/GB-month | 0.1 |
| NAT gateway | none (`enable_nat_gateway = false`) | | 0 |
| **Total** | | | **≈ 69** |

That works out to about **USD 2.3 per day** or **USD 0.095 per hour**.

The previous default (private-subnet tasks behind one NAT gateway) cost **≈ USD 110–115/month**. Dropping the NAT gateway removes ≈ 43.1 (hourly) + ≈ 0.3 (≈ 5 GB processed) + 3.65 (its Elastic IP). The task's own public IPv4 adds 3.65 back.

**NAT gateway price, for reference.** At the review the instructor put the NAT gateway at "$2 or something per AZ" plus traffic. That is about right **per day**: the ap-southeast-1 list price is **$0.059/h per NAT gateway**, ≈ USD 1.42/day, which comes to ≈ **USD 43/month per AZ**, plus **$0.059/GB** processed.

## Target HA design (for the report, not deployed)

Values from the commented "HA / target design" block in `terraform.tfvars.example`, at the autoscaling minimum of 2 tasks.

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| NAT gateways | 2 (one per AZ, `single_nat_gateway = false`) | $0.059/h each + $0.059/GB | 2 × 43.1 + ~0.3 = 86.5 |
| NAT Elastic IPs | 2 | $0.005/h each | 7.3 |
| Application Load Balancer | 1, ~1 LCU average | as above | 24.2 |
| ALB public IPv4 | 2 | $0.005/h each | 7.3 |
| RDS PostgreSQL | `db.t4g.micro`, **Multi-AZ** | ≈ $0.050/h | 36.6 |
| RDS storage | 20 GB gp3, Multi-AZ | ≈ $0.276/GB-month | 5.5 |
| ECS Fargate | 2 tasks minimum (one per AZ), private subnets, no public IP | as above | 2 × 11.3 = 22.6 |
| Secrets Manager + CloudWatch Logs + ECR | as above | | ≈ 1.5 |
| **Total** | | | **≈ 190** (191.5) |

That is about **USD 6.3 per day**. Each extra task while scaled out (up to `autoscaling_max_capacity = 4`) adds ≈ 11.3/month. Using `enable_vpc_endpoints = true` instead of the two NAT gateways would cost about the same (≈ USD 95/month for 5 endpoints × 2 AZs versus ≈ 94 for 2 NAT + 2 EIP).

## What moves the number

Relative to the implementation default (≈ USD 69/month):

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
4. **Free tier** (only if the account is eligible; it depends on account age and plan): it may cover 750 h/month of a single-AZ RDS micro instance with 20 GB storage, and some ALB hours. Don't count on it until you've checked the account's Billing → Free tier page. The AWS credits have not been received yet.
5. Keep an **AWS Budgets** alert on the account (owner: Cody).

## Not included

These belong to teammates' stacks and are billed separately. Most are pay-per-request and near zero at dev traffic, but check each one:

- CloudFront + S3 static site (Cody)
- **WAF**: about USD 5/month per web ACL + USD 1/month per rule + request charges. This is a fixed cost even when idle (Cody)
- Route 53 hosted zone (USD 0.50/month) and domain (Cody)
- API Gateway (Andrew)
- Cognito (Andrew)
- Lambda (`queue-manager`, `ticket-fn`), SQS, SNS, DynamoDB, EventBridge Scheduler (Yan Ting, Shi Hui). A per-minute schedule is ≈ 43,800 invocations/month, inside the Scheduler free tier of 14 M/month (then ≈ USD 1 per million); scope it to the sale window anyway.
- SES and the e-ticket S3 bucket (Shi Hui)
- QuickSight: per-user subscription, can be the largest line item if left on
- Data transfer out to the internet, KMS customer-managed keys, CloudTrail beyond the free trail
