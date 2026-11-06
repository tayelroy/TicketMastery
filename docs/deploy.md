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

When `RUN_MIGRATIONS_ON_START=true`, the API applies pending SQL migrations from `services/ticketmastery-api/migrations/` at container start. The run holds a Postgres advisory lock, so several tasks starting together are safe: all five ECS services (one per use case) run the same image with migrations on, the first task to start applies them, and the others wait for the lock and then find nothing to do. A failing migration stops the task, and the ECS deployment circuit breaker rolls back that service. The app's own default is `false`; the ECS task definitions set it to `true` via the Terraform variable `run_migrations_on_start` (default `true`). Check the API logs for the migration lines after the first deploy.

## Verify

```bash
cd infra/envs/dev
curl -i "$(terraform output -raw api_endpoint)/health"
curl -i "https://$(terraform output -raw cloudfront_domain_name)/health"
```

Expect `200` with `{"status":"ok","db":"ok",...}`. The ALB is internal, so `alb_dns_name` only resolves to private IPs and can't be reached from a laptop; test through API Gateway (or CloudFront, which forwards `/health` and `/api/*` to it). A `503` with JSON `"db":"down"` comes from the API itself: the API can't reach the database (check the SG chain, the secret, and `DB_SSL`). `{"message":"Service Unavailable"}` from API Gateway means the VPC link can't reach the ALB or no task is registered yet. `/health/live` answers without touching the DB. If it isn't healthy after a few minutes:

```bash
aws logs tail "$(terraform output -raw log_group_name)" --follow   # all services; streams are prefixed <service key>/
for s in $(terraform output -json ecs_service_names | jq -r '.[]'); do
  echo "== $s"
  aws ecs describe-services --cluster "$(terraform output -raw ecs_cluster_name)" \
    --services "$s" --query 'services[0].events[0:5]'
done
```

`/health` is answered by the `discovery` service (the ALB default). Each service logs the modules it mounts in its `ticketmastery-api listening` line (e.g. `"modules":["checkout"]`); a path that reaches a service not mounting it answers `404 not_found`, which means a listener rule is missing.

Until Cognito is live, the service runs `AUTH_MODE=dev-header`. API Gateway's JWT authorizer guards the protected routes, but **anyone with a valid Cognito token can send `x-dev-user-id` / `x-dev-user-groups` and impersonate any user**, so don't leave it running with real data, and switch `auth_mode = "cognito"` as soon as the API verifies tokens (#12).

## Reading the DB secret

RDS manages the master credentials in Secrets Manager (JSON keys `username`, `password`):

```bash
aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw db_secret_arn)" \
  --query SecretString --output text
```

Print it only when you need it. Never paste it into chat, code, `.env` files, or tickets. The database is in private subnets and **can't be reached from your laptop**. Debug through the API, or with ECS Exec into a running API task (on by default, `enable_execute_command = true`; needs the Session Manager plugin). Any service's task has the DB settings; this uses `discovery`:

```bash
TASK=$(aws ecs list-tasks --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service-name "$(terraform output -json ecs_service_names | jq -r '.discovery')" --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster "$(terraform output -raw ecs_cluster_name)" --task "$TASK" \
  --container ticketmastery-api --interactive --command "sh"
```

`loadtest/scripts/nfr3-oversell-check.sh` uses this to run its SQL check inside the VPC.

## Deploying a new image

There is one image for all five ECS services (discovery, account, waiting-room, checkout, organiser); each service runs it with its own `API_MODULES`.

1. Build and push a new tag (step 2 above).
2. Either set `image_tag` to the new tag and run `terraform plan -out tfplan && terraform apply tfplan` (every service gets a new task definition revision and rolls on its own, each with its own circuit breaker), or re-push `latest` and force a redeploy of every service:

   ```bash
   for s in $(terraform output -json ecs_service_names | jq -r '.[]'); do
     aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" \
       --service "$s" --force-new-deployment --query 'service.serviceName' --output text
   done
   ```

   To roll out only one service, run the `update-service` line for that one name (e.g. `jq -r '.checkout'`); the others keep their running tasks.

The API image is deployed by hand like this; only the frontend has a pipeline (next section).

### Cutover from the single `ticketmastery-dev-api` service

The first apply after the per-service split replaces the single API service, its task definition family, target group and autoscaling resources with five of each. The cluster, ALB, listeners, log group and IAM roles stay. Expect a short gap on dev while the new services register: the listener's default action switches to the new `discovery` target group, and the old service is deleted once nothing references its target group.

## Deploying the frontend

The `Deploy Frontend to AWS` workflow (manual, `main` only) builds `frontend/` with Cognito sign-in, syncs it to the
frontend bucket and invalidates CloudFront. To deploy from another branch, run the same steps by hand from the repo
root:

```bash
cd infra/envs/dev
POOL=$(terraform output -raw cognito_user_pool_id); CLIENT=$(terraform output -raw cognito_user_pool_client_id)
BUCKET=$(terraform output -raw frontend_bucket_name); DIST=$(terraform output -raw cloudfront_distribution_id)
cd ../../../frontend
VITE_AUTH_MODE=cognito VITE_COGNITO_USER_POOL_ID=$POOL VITE_COGNITO_CLIENT_ID=$CLIENT VITE_API_BASE_URL="" npm run build
aws s3 sync dist/ "s3://$BUCKET/" --exclude index.html --exclude 'assets/*' --cache-control public,max-age=300
aws s3 sync dist/assets/ "s3://$BUCKET/assets/" --cache-control public,max-age=31536000,immutable
aws s3 cp dist/index.html "s3://$BUCKET/index.html" --cache-control no-cache,no-store,must-revalidate --content-type text/html
aws cloudfront create-invalidation --distribution-id "$DIST" --paths '/*'
```

## After the first apply of the e-ticket pipeline and monitoring

AWS sends two emails to `contact_email` (`terraform.tfvars`, default the team address) that someone has to click:

1. **SES "Email Address Verification Request"**: verifies the e-ticket sender. Until then `ticket-fn` can't send, and
   orders land in `ticket-dlq` after 5 tries (re-drive them afterwards; already-emailed orders are skipped). Check with
   `aws sesv2 get-email-identity --email-identity <address> --query VerifiedForSendingStatus`.
2. **SNS "Subscription Confirmation"** for `ticketmastery-dev-alerts`: until confirmed, alarm emails are dropped.

The account is in the **SES sandbox**: every recipient must also be a verified identity (or an SES mailbox-simulator
address such as `success@simulator.amazonses.com`). Before a demo, verify each demo fan's email in the SES console.

When you change `lambdas/ticket-fn/src`, run `npm run build` in `lambdas/ticket-fn` and commit `bundle/index.js`:
Terraform zips the committed bundle.

## Switching to the HA target design

The HA design is for the diagram and report. Deploy it only if the team agrees to the cost (≈ USD 194/month instead of ≈ 72 for the whole stack; see [cost-estimate.md](cost-estimate.md)). Copy the values from the commented "HA / target design" block at the bottom of `terraform.tfvars.example` into `terraform.tfvars`. Apply in two steps, so the NAT routes exist before tasks move into the private subnets:

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

Destroy when you aren't demoing. The default (implementation-mode) stack costs about USD 2.4/day; the HA target design about USD 6.4/day (see [cost-estimate.md](cost-estimate.md)). If you deployed the HA design, set `db_deletion_protection = false` and apply before destroying.

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
- Everything else in `infra/envs/dev` (CloudFront, API Gateway, Lambdas, queues, monitoring) is in the same state and goes with the same `terraform destroy`. The e-ticket and frontend buckets have `force_destroy` on in dev.

The `monitoring` module creates the account's **AWS Budgets** budget (USD 80/month, alerts at USD 20/40/60/80 actual and on forecast); `terraform destroy` removes it too, so recreate one by hand if the account stays in use.
