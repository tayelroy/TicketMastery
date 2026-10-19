# Deploying the base stack (dev)

This deploys the VPC, security groups, ECR, RDS, and the `ticketmastery-api` ECS service behind the ALB, into `ap-southeast-1`.

> **Before any `apply` or `destroy`, tell the team in the group chat.** Cody owns the AWS account. While state is local (the default), **only one person applies `dev`**, because state lives on that person's laptop.

## Prerequisites

- Terraform **>= 1.6** (>= 1.10 if you use the S3-native lockfile; see [Remote state](#optional-remote-state))
- AWS CLI v2
- Docker with `buildx` (for `--platform linux/amd64` on Apple Silicon)
- An AWS profile with access to the team account

```bash
# IAM Identity Center (preferred):
aws configure sso --profile ticketmastery
aws sso login --profile ticketmastery
# or access keys (stored in ~/.aws, never in the repo):
aws configure --profile ticketmastery

export AWS_PROFILE=ticketmastery
aws sts get-caller-identity   # sanity check: right account?
```

## Configure

```bash
cd infra/envs/dev
cp terraform.tfvars.example terraform.tfvars   # gitignored; never commit it
terraform init
```

The defaults build the **implementation** mode agreed with the instructor (single-AZ, no NAT gateway, no HA; see [architecture.md](architecture.md#implementation-vs-target-ha-design)): **no NAT gateway**, one 0.25 vCPU / 0.5 GB task in the **AZ a public subnet with a public IP** (its egress to ECR, CloudWatch Logs, Secrets Manager, and Cognito; inbound is still only from the ALB security group), `db.t4g.micro` single-AZ RDS pinned to AZ a in the private subnets, and autoscaling off. `terraform.tfvars.example` documents every toggle and has a commented block for the HA target design. Put no secrets in `terraform.tfvars`. The DB password is generated and stored by RDS.

## First deploy (empty ECR)

The ECS service needs an image that doesn't exist yet. Create the repository first, push an image, then apply everything.

1. **Create only the ECR repository:**

   ```bash
   terraform apply -target=module.ecr
   ```

   Terraform warns that `-target` is for exceptional cases. That's expected here.

2. **Build and push the API image** from the repo root. The task runs `X86_64` by default (`cpu_architecture`), so build `linux/amd64`:

   ```bash
   REGION=ap-southeast-1
   REPO=$(terraform -chdir=infra/envs/dev output -raw ecr_repository_url 2>/dev/null \
     || aws ecr describe-repositories --repository-names ticketmastery-api \
          --query 'repositories[0].repositoryUri' --output text)
   TAG=$(git rev-parse --short HEAD)

   aws ecr get-login-password --region "$REGION" \
     | docker login --username AWS --password-stdin "${REPO%%/*}"
   docker build --platform linux/amd64 -t "$REPO:$TAG" services/ticketmastery-api
   docker push "$REPO:$TAG"
   ```

3. **Point Terraform at that tag** with `image_tag = "<TAG>"` in `terraform.tfvars`. You can also push the same image as `latest` (the default `image_tag`).

4. **Plan and apply everything:**

   ```bash
   cd infra/envs/dev
   terraform plan -out tfplan
   terraform apply tfplan
   ```

   RDS takes about 5–10 minutes to create. `tfplan` is gitignored. Delete it after applying, because it can contain sensitive values.

### Migrations

When `RUN_MIGRATIONS_ON_START=true`, the API applies pending SQL migrations from `services/ticketmastery-api/migrations/` at container start. The run holds a Postgres advisory lock, so several tasks starting together are safe. A failing migration stops the task, and the ECS deployment circuit breaker rolls back. The app's own default is `false`; the ECS task definition sets it to `true` via the Terraform variable `run_migrations_on_start` (default `true`). Check the API logs for the migration lines after the first deploy.

## Verify

```bash
cd infra/envs/dev
curl -i "http://$(terraform output -raw alb_dns_name)/health"
```

Expect `200` with `{"status":"ok","db":"ok",...}`. A `503` with JSON `"db":"down"` comes from the API itself: the API can't reach the database (check the SG chain, the secret, and `DB_SSL`). A plain `502`/`503` page from the ALB means no task is registered or running yet. `/health/live` answers without touching the DB. Always test through the ALB: the task's public IP accepts no inbound connections (only the ALB security group may connect). If it isn't healthy after a few minutes:

```bash
aws logs tail "$(terraform output -raw log_group_name)" --follow
aws ecs describe-services --cluster "$(terraform output -raw ecs_cluster_name)" \
  --services "$(terraform output -raw ecs_service_name)" --query 'services[0].events[0:5]'
```

Until Cognito is live, the service runs `AUTH_MODE=dev-header`. **Anyone who can reach the ALB can impersonate any user**, so don't leave it running with real data, and switch `auth_mode = "cognito"` as soon as Andrew's authorizer exists.

## Reading the DB secret

RDS manages the master credentials in Secrets Manager (JSON keys `username`, `password`):

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw db_secret_arn)" \
  --query SecretString --output text
```

Print it only when you need it. Never paste it into chat, code, `.env` files, or tickets. The database is in private subnets and **can't be reached from your laptop**. Debug through the API, or use ECS Exec / a temporary bastion if the team agrees to one.

## Deploying a new image

1. Build and push a new tag (step 2 above).
2. Either set `image_tag` to the new tag and run `terraform plan -out tfplan && terraform apply tfplan`, or re-push `latest` and force a redeploy:

   ```bash
   aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" \
     --service "$(terraform output -raw ecs_service_name)" --force-new-deployment
   ```

Whether Cody's pipeline takes this over is an [open question](architecture.md#open-questions).

## Switching to the HA target design

The HA design is for the diagram and report. Deploy it only if the team agrees to the cost (≈ USD 190/month instead of ≈ 69; see [cost-estimate.md](cost-estimate.md)). Copy the values from the commented "HA / target design" block at the bottom of `terraform.tfvars.example` into `terraform.tfvars`. Apply in two steps, so the NAT routes exist before tasks move into the private subnets:

1. Network first: set `enable_nat_gateway = true` and `single_nat_gateway = false` (or `enable_vpc_endpoints = true`), then `terraform plan -out tfplan && terraform apply tfplan`.
2. Everything else: set `tasks_in_public_subnets = false`, `tasks_single_az = false`, `desired_count = 2`, `enable_autoscaling = true`, `autoscaling_min_capacity = 2`, `autoscaling_max_capacity = 4`, `db_multi_az = true`, `db_deletion_protection = true`, `db_backup_retention_period = 7`, then plan and apply again.

What the plan does:

- **ECS service**: changing `tasks_in_public_subnets` or `tasks_single_az` is an **in-place update** of the service's network configuration (`~ update in-place`, not a replacement). ECS starts a new deployment: tasks in the new subnets start and register with the ALB, then the old tasks drain and stop. Expect a brief task replacement, not an outage. If the new tasks can't pull the image (e.g. no NAT route yet), the circuit breaker rolls back; fix the egress and apply again.
- **RDS**: `db_multi_az = true` converts the instance in place and removes the AZ pin. Do it outside a demo.

Going back to the implementation mode is the reverse: restore the defaults. One apply is fine, because tasks in the public subnet don't need the NAT gateway. **Read the plan before applying:** with `db_multi_az = false`, the DB is pinned to AZ a again, and `availability_zone` can't be changed in place. If the current primary is in AZ b (e.g. after a failover), Terraform plans `aws_db_instance.this must be replaced` and **all data is lost**. The same applies the first time you apply this version against a stack created before the AZ pin existed, if RDS had placed the instance outside AZ a. Check with `aws rds describe-db-instances --query 'DBInstances[].AvailabilityZone'`, and don't apply a DB replacement you didn't intend.

## Optional: remote state

State is local by default (`backend.tf`). To share it, the account owner creates the backend once:

- **S3 bucket** (e.g. `ticketmastery-tfstate-<account-id>`) with **versioning** and default encryption on, and public access blocked; and
- for locking, **either** a DynamoDB table (e.g. `ticketmastery-tf-locks`, partition key `LockID` of type String) **or** S3-native locking (`use_lockfile = true`, which needs Terraform >= 1.10 for everyone on the team).

Then replace the `local` backend in `infra/envs/dev/backend.tf` with the commented `s3` block. With S3-native locking, swap `dynamodb_table = ...` for `use_lockfile = true`. Migrate:

```bash
terraform init -migrate-state
```

## Teardown

Destroy when you aren't demoing. The default (implementation-mode) stack costs about USD 2.3/day; the HA target design about USD 6.3/day (see [cost-estimate.md](cost-estimate.md)). If you deployed the HA design, set `db_deletion_protection = false` and apply before destroying.

```bash
cd infra/envs/dev
terraform destroy
```

Dev defaults make this clean:

- RDS: `db_skip_final_snapshot = true` and `db_deletion_protection = false`. **All data is lost.** Set `db_skip_final_snapshot = false` first if you want a final snapshot.
- ECR: `ecr_force_delete = true`, so images are deleted with the repository.
- The RDS-managed master secret is deleted together with the instance.

Afterwards, check the console in `ap-southeast-1` for leftovers that keep billing:

- **EC2 → Network Interfaces**: ENIs left by VPC Lambdas can block subnet/SG deletion for a while. Retry `destroy` after a few minutes.
- **EC2 → Elastic IPs**: unattached EIPs are billed.
- **CloudWatch → Log groups**: groups created outside Terraform (Lambda, ECS Exec).
- **RDS → Snapshots**: manual or final snapshots.
- **Secrets Manager**: secrets other modules created. Deleted secrets sit in a recovery window, and you can't reuse the name until it ends.
- Teammates' stacks (CloudFront, API Gateway, Lambda, …): ask them to destroy theirs.

Make sure an **AWS Budgets** alert exists on the account (e.g. USD 50/month with alerts at 50/80/100%). Cody owns the account, so ask him to confirm it.
