# Cost estimate: base stack (dev)

> **ESTIMATE ONLY.** On-demand list prices for **ap-southeast-1 (Singapore)** in USD, excluding tax. 730 hours/month, default `terraform.tfvars.example` settings, light dev/demo traffic. Prices change, so **check in the [AWS Pricing Calculator](https://calculator.aws/)** before relying on these numbers.

## Monthly, if left running 24/7

| Item | Assumption | Rate | ≈ USD / month |
|---|---|---|---|
| NAT gateway | 1 (`single_nat_gateway = true`) | $0.059/h + $0.059/GB processed | 43.1 + ~0.3 (≈5 GB) |
| Application Load Balancer | 1, ~1 LCU average | $0.0252/h + $0.008/LCU-h | 18.4 + 5.8 |
| RDS PostgreSQL | `db.t4g.micro`, **single-AZ** | ≈ $0.025/h | 18.3 |
| RDS storage | 20 GB gp3 | ≈ $0.138/GB-month | 2.8 |
| ECS Fargate (Linux/x86) | 1 task, 0.25 vCPU / 0.5 GB | $0.05056/vCPU-h + $0.00553/GB-h | 9.2 + 2.0 = 11.3 |
| Public IPv4 addresses | ALB (2, one per AZ) + NAT EIP (1) | $0.005/h each | 11.0 |
| Secrets Manager | 1 secret (RDS-managed master) | $0.40/secret-month | 0.4 |
| CloudWatch Logs | ~1 GB ingested, 14-day retention | ingest + storage | 0.7–1.0 |
| ECR | < 1 GB of images | $0.10/GB-month | 0.1 |
| **Total** | | | **≈ 110–115** |

That works out to about **USD 3.7 per day** or **USD 0.15 per hour**.

### What moves the number

| Change | Effect |
|---|---|
| `db_multi_az = true` | RDS instance + storage roughly **double**: +≈ USD 21 (≈ 42 for RDS in total) |
| Autoscaling to `autoscaling_max_capacity = 4` | Each extra task adds ≈ USD 11.3/month while it runs |
| `cpu_architecture = "ARM64"` (Graviton, arm64 image) | Fargate ≈ 20% cheaper |
| `container_insights = "enabled"` | Extra CloudWatch custom metrics, a few USD/month |
| `single_nat_gateway = false` | Second NAT + EIP: +≈ USD 47 |
| `enable_vpc_endpoints = true` instead of NAT | **More expensive**: interface endpoints cost ≈ $0.013/h per AZ per endpoint. 5 endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs) × 2 AZs ≈ **USD 95/month** plus $0.013/GB, versus ≈ USD 43 for one NAT. Keep the single NAT. |

## Saving money

1. **Destroy the stack when you aren't working on it or demoing** (`terraform destroy`, see [deploy.md](deploy.md#teardown)). This is by far the biggest saving: re-creating it takes about 15 minutes.
2. If the stack must stay up but idle, set `enable_nat_gateway = false`. That saves about USD 43 + 3.7 (NAT + its EIP). **Without NAT, tasks in the private subnets can't pull images from ECR, ship logs, read the DB secret, or reach Cognito.** Running tasks keep serving until they restart, and new deployments fail. Only do this when nothing needs to start.
3. Set `desired_count = 0` to stop paying for Fargate while keeping everything else.
4. **Free tier** (only if the account is eligible; it depends on account age and plan): it may cover 750 h/month of a single-AZ RDS micro instance with 20 GB storage, and some ALB hours. Don't count on it until you've checked the account's Billing → Free tier page.
5. Keep an **AWS Budgets** alert on the account (owner: Cody).

## Not included

These belong to teammates' stacks and are billed separately. Most are pay-per-request and near zero at dev traffic, but check each one:

- CloudFront + S3 static site (Cody)
- **WAF**: about USD 5/month per web ACL + USD 1/month per rule + request charges. This is a fixed cost even when idle (Cody)
- Route 53 hosted zone (USD 0.50/month) and domain (Cody)
- API Gateway (Andrew)
- Cognito (Andrew)
- Lambda (`queue-manager`, `ticket-fn`), SQS, SNS, DynamoDB, EventBridge Scheduler (Yan Ting, Shi Hui)
- SES and the e-ticket S3 bucket (Shi Hui)
- QuickSight: per-user subscription, can be the largest line item if left on
- Data transfer out to the internet, KMS customer-managed keys, CloudTrail beyond the free trail
