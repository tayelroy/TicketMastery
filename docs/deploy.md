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

The defaults are sized for dev: one NAT gateway, `db.t4g.micro`, single-AZ RDS, and one 0.25 vCPU / 0.5 GB task. `terraform.tfvars.example` documents every toggle. Put no secrets in `terraform.tfvars`. The DB password is generated and stored by RDS.

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

Expect `200` with `{"status":"ok","db":"ok",...}`. A `503` with JSON `"db":"down"` comes from the API itself: the API can't reach the database (check the SG chain, the secret, and `DB_SSL`). A plain `502`/`503` page from the ALB means no task is registered or running yet. `/health/live` answers without touching the DB. If it isn't healthy after a few minutes:

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

## Optional: remote state

State is local by default (`backend.tf`). To share it, the account owner creates the backend once:

- **S3 bucket** (e.g. `ticketmastery-tfstate-<account-id>`) with **versioning** and default encryption on, and public access blocked; and
- for locking, **either** a DynamoDB table (e.g. `ticketmastery-tf-locks`, partition key `LockID` of type String) **or** S3-native locking (`use_lockfile = true`, which needs Terraform >= 1.10 for everyone on the team).

Then replace the `local` backend in `infra/envs/dev/backend.tf` with the commented `s3` block. With S3-native locking, swap `dynamodb_table = ...` for `use_lockfile = true`. Migrate:

```bash
terraform init -migrate-state
```

## Teardown

Destroy when you aren't demoing. The stack costs about USD 3.7/day (see [cost-estimate.md](cost-estimate.md)).

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
