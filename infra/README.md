# TicketMastery infra

Terraform for the shared base: VPC, security groups, ECR, RDS PostgreSQL, and the `ticketmastery-api` image running as one ECS Fargate service per use case behind one ALB. Region `ap-southeast-1`.

## Layout

```
infra/
├── envs/dev/            root module: wires the modules, owns state
│   ├── versions.tf      terraform >= 1.10, aws ~> 5.0, random ~> 3.6
│   ├── providers.tf     region + default tags (no profile; use AWS_PROFILE)
│   ├── backend.tf       S3 remote state with native lockfile
│   ├── main.tf          module wiring
│   ├── variables.tf / outputs.tf / terraform.tfvars.example
└── modules/
    ├── network/         VPC 10.20.0.0/16, 2 public + 2 private subnets, IGW, NAT, endpoints
    ├── security/        alb_sg -> ecs_sg -> rds_sg chain
    ├── ecr/             ticketmastery-api repo, scan on push, keep last 10 images
    ├── rds/             PostgreSQL 16, db.t4g.micro, password managed in Secrets Manager
    ├── ecs-service/     log group, cluster, IAM roles, ALB, and per service: task def, target group, listener rule, service, autoscaling
    ├── edge/            (Cody) frontend S3 bucket, CloudFront, WAF
    ├── github-deploy/   (Cody) GitHub Actions OIDC role for the frontend deploy
    ├── auth-apigw/      (Andrew) Cognito user pool + HTTP API with JWT authorizer and VPC link
    ├── waiting-room/    (Yan Ting) SQS FIFO join-queue, DynamoDB live-queue, queue-manager Lambda, admit schedule
    ├── messaging/       (Shi Hui) SNS order-events, SQS ticket-queue + DLQ, ticket-fn, e-ticket bucket, SES
    └── monitoring/      CloudWatch alarms -> SNS alerts email, dashboard, AWS Budgets
```

| Module | Key outputs |
|---|---|
| network | `vpc_id`, `vpc_cidr`, `azs`, `public_subnet_ids`, `private_subnet_ids`, `private_route_table_ids` |
| security | `alb_sg_id`, `ecs_sg_id`, `rds_sg_id` |
| ecr | `repository_url` |
| rds | `address`, `port`, `db_name`, `master_user_secret_arn`, `availability_zone` |
| ecs-service | `alb_dns_name`, `alb_arn_suffix`, `http_listener_arn`, `https_listener_arn`, `cluster_name`, `services` (per key: service name, task def, target group ARN + suffix, scaling bounds), `service_names`, `target_group_arn_suffixes`, `default_target_group_arn`, `path_routes`, `task_role_name`, `task_role_arn`, `task_subnet_ids` |
| monitoring | `alerts_topic_arn`, `dashboard_url` |

## Usage

```bash
export AWS_PROFILE=<your-profile>
cd infra/envs/dev
cp terraform.tfvars.example terraform.tfvars   # gitignored; edit as needed
terraform init
terraform plan
```

State is shared in S3 (`ticketmastery-tfstate-000246635159`, key `envs/dev/terraform.tfstate`) and locked with an S3 lockfile, so only one apply runs at a time. You need credentials for account 000246635159 to run any Terraform command.

### Implementation mode vs HA target, and cost toggles

The defaults build the **implementation** mode the instructor asked for: one AZ, no NAT gateway, no HA. The commented block at the bottom of `envs/dev/terraform.tfvars.example` flips everything to the **HA target design** shown in the report (see [docs/architecture.md](../docs/architecture.md#implementation-vs-target-ha-design)).

| Variable | Default | Effect | HA target |
|---|---|---|---|
| `tasks_in_public_subnets` | `true` | Tasks run in the public subnets with a public IP, which is their egress (no NAT needed). Inbound is still only from the ALB SG. `false` = private subnets, no public IP | `false` |
| `tasks_single_az` | `true` | Tasks only in the first AZ (AZ a). `false` = across both AZs | `false` |
| `enable_nat_gateway` | `false` | NAT for private-subnet egress (~USD 43/month each + USD 0.059/GB). Needed only for private-subnet tasks (unless interface endpoints cover them) or in-VPC Lambdas | `true` |
| `single_nat_gateway` | `true` | one NAT in AZ a instead of one per AZ | `false` |
| `enable_gateway_endpoints` | `true` | S3 + DynamoDB gateway endpoints on the private route tables (free) | `true` |
| `enable_vpc_endpoints` | `false` | interface endpoints ecr.api, ecr.dkr, logs, secretsmanager, sqs (~USD 95/month); alternative to NAT | optional |
| `desired_count` | `1` | Task count of every service without its own `ecs_services[*].desired_count` | `2` |
| `enable_autoscaling` | `false` | CPU + ALB request-count target tracking, per service | `true` |
| `autoscaling_min_capacity` / `autoscaling_max_capacity` | `1` / `2` | Autoscaling bounds for services that don't set `autoscaling_min` / `autoscaling_max` in `ecs_services` (the dev defaults set max 3 for discovery, waiting-room, checkout and 2 for account, organiser) | `2` / `4`+ |
| `db_multi_az` | `false` | RDS standby in a second AZ. While `false`, `envs/dev` pins the instance to AZ a (`availability_zone`); the pin is dropped when `true` | `true` |
| `db_deletion_protection` / `db_backup_retention_period` | `false` / `1` | Deletion protection / automated backup retention (days) | `true` / `7` |
| `container_insights` | `disabled` | ECS Container Insights metrics | optional |

Two public and two private subnets always exist, even in single-AZ mode: an ALB needs subnets in at least two AZs, and an RDS DB subnet group must span at least two AZs. In implementation mode the tasks and the DB all run in AZ a.

Private-subnet tasks (`tasks_in_public_subnets = false`) have no public IP. They need NAT, or **both** gateway and interface endpoints, otherwise they can't pull images, ship logs, or read the DB secret. A `check` block (`task_egress`) in `envs/dev/main.tf` warns about this. Changing either task placement variable is an in-place update of the ECS service and rolls the tasks into the new subnets.

In-VPC Lambdas never get a public IP, so with NAT off they have no internet or AWS-API egress. Keep Lambdas outside the VPC unless they need RDS (see step 4 below).

### Database credentials

RDS generates the master password and stores it in Secrets Manager (`db_secret_arn`, JSON keys `username` and `password`). The password never appears in code or state. ECS gets the values as `DB_USER` and `DB_PASSWORD` through task definition `secrets`. Lambdas should read the secret at runtime, using an IAM policy that allows `secretsmanager:GetSecretValue` on that ARN.

### One ECS service per use case

`ecs_services` (in `envs/dev/variables.tf`) defines one ECS service per use case. All run the same image; the task definition sets `API_MODULES` so each mounts only its routes (`/health` is always mounted):

| Key | Use case | ECS service / task family | Target group | ALB routing | Autoscaling max |
|---|---|---|---|---|---|
| `discovery` | UC1 | `ticketmastery-dev-discovery` | `ticketmastery-dev-discovery-tg` | listener default (`/api/concerts*`, `/health`, anything unmatched) | 3 |
| `account` | UC2 | `ticketmastery-dev-account` | `ticketmastery-dev-account-tg` | rule 110: `/api/me`, `/api/me/*` | 2 |
| `waiting-room` | UC3 | `ticketmastery-dev-waiting-room` | `ticketmastery-dev-wroom-tg` (32-character limit) | rule 120: `/api/waiting-room`, `/api/waiting-room/*` | 3 |
| `checkout` | UC4 | `ticketmastery-dev-checkout` | `ticketmastery-dev-checkout-tg` | rule 130: `/api/checkout`, `/api/checkout/*` | 3 |
| `organiser` | UC5 | `ticketmastery-dev-organiser` | `ticketmastery-dev-organiser-tg` | rule 140: `/api/organiser`, `/api/organiser/*` | 2 |

Each service has its own task definition, target group, deployments (circuit breaker per service) and, with `enable_autoscaling = true`, its own scalable target plus CPU and `ALBRequestCountPerTarget` policies on its own target group, so a browsing surge scales only `discovery`. Monitoring has per-service alarms and dashboard lines (`modules/monitoring/README.md`).

- **Sizes and counts.** Each entry may set `desired_count`, `autoscaling_min`, `autoscaling_max`, `cpu`, `memory`. A value set in `ecs_services` wins; unset ones fall back to `desired_count`, `autoscaling_min_capacity`, `autoscaling_max_capacity`, `task_cpu`, `task_memory`. The dev defaults set only `autoscaling_max`, so all five run 0.25 vCPU / 0.5 GB with 1 task. To change one service, override the whole map in `terraform.tfvars` (a map variable is replaced, not merged), e.g. copy the default and add `cpu = 512, memory = 1024` to `checkout`.
- **Routing.** Listener rules sit on the forwarding listener (HTTP, or HTTPS when `certificate_arn` is set). Priorities are fixed in `ecs_services`; keep them stable and above 20 (1-20 are `auth-apigw`'s `origin_header` rules, which mirror these routes behind the `x-origin-verify` check).
- **Logs.** One log group (`/ecs/ticketmastery-api`) for all services; streams are prefixed with the service key (`checkout/ticketmastery-api/<task-id>`), so one Logs Insights query or metric filter still covers the whole API.
- **Migrations.** `run_migrations_on_start` stays on for every service: migrations run under a Postgres advisory lock, so the first task applies them and the others wait, then find nothing to do. Any service can start first after a new image.
- **IAM.** One shared task role and execution role for all services (teammates' policies attach to `task_role_name`). Next step: a task role per service with only its use case's permissions (e.g. only `waiting-room` and `checkout` need the DynamoDB live-queue).
- **DB connections.** Each task's pool opens up to `DB_POOL_MAX = 10` connections; see `modules/monitoring/README.md` (RDS max_connections) before raising the autoscaling maximums.

### Deploying a new image

All services use the one image `<ecr_repository_url>:<image_tag>`. You can push a new tag and set `image_tag`, then apply: every service's task definition gets a new revision and each service rolls on its own. Or you can re-push `latest` and force a new deployment of each service: `for s in $(terraform output -json ecs_service_names | jq -r '.[]'); do aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" --service "$s" --force-new-deployment >/dev/null; done`. The deployment circuit breaker rolls back failed deployments, per service.

`auth_mode` defaults to `dev-header` for development. It **must** be switched to `cognito` once the Cognito/API Gateway authorizer is live.

### Deploying the frontend and clearing the CloudFront cache

The `Deploy Frontend to AWS` workflow (manual, `main` only) builds `frontend/`, syncs it to the frontend bucket, then clears the CloudFront cache with a `/*` invalidation so users get the new `index.html` right away. Hashed files under `assets/` are cached for a year and never need clearing. The workflow reads three repo variables, which must be set again after every fresh apply because the IDs change:

```bash
cd infra/envs/dev
gh variable set AWS_DEPLOY_ROLE_ARN        --body "$(terraform output -raw github_deploy_role_arn)"
gh variable set FRONTEND_BUCKET_NAME       --body "$(terraform output -raw frontend_bucket_name)"
gh variable set CLOUDFRONT_DISTRIBUTION_ID --body "$(terraform output -raw cloudfront_distribution_id)"
```

To clear the cache by hand: `aws cloudfront create-invalidation --distribution-id "$(terraform output -raw cloudfront_distribution_id)" --paths "/*"`.

## Adding your own module (e.g. waiting room)

1. Create `infra/modules/waiting-room/` with `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`, following the existing modules. Take shared values as variables; don't look them up with data sources.
2. Wire it in `infra/envs/dev/main.tf`:

   ```hcl
   module "waiting_room" {
     source = "../../modules/waiting-room"

     name               = local.name
     private_subnet_ids = module.network.private_subnet_ids
     vpc_id             = module.network.vpc_id
     api_task_role_name = module.ecs_service.task_role_name # grant the API sqs:SendMessage etc.
   }
   ```

3. Grant the API access from inside your module by attaching a least-privilege policy to the task role:

   ```hcl
   resource "aws_iam_role_policy" "api_join_queue" {
     name   = "waiting-room-join-queue"
     role   = var.api_task_role_name
     policy = data.aws_iam_policy_document.api_join_queue.json
   }
   ```

4. Keep Lambdas **outside the VPC** unless they need RDS: an in-VPC Lambda never gets a public IP (even in a public subnet), so with the default `enable_nat_gateway = false` it can't reach the internet or AWS APIs. A Lambda that needs RDS should run in `private_subnet_ids` with its own SG. Add that SG to RDS ingress by setting `rds_extra_ingress_sg_ids = [module.waiting_room.lambda_sg_id]` in the `security` module call (a root variable, so you can also put it in tfvars). Give it only the egress it needs: the S3/DynamoDB gateway endpoints are free and already on; SQS/SNS/Secrets Manager need an interface endpoint each (~USD 0.013/h per AZ) or `enable_nat_gateway = true`.
5. To give the API a queue URL or ARN, set `extra_environment = { JOIN_QUEUE_URL = module.waiting_room.join_queue_url }` on the `ecs_service` module. Only non-secret values belong there.
6. Add any outputs others need to `envs/dev/outputs.tf`, each with a `description`.
7. Run `terraform fmt -recursive infra && terraform -chdir=infra/envs/dev validate` before opening a PR.

## Consuming outputs from a separate stack

If your stack lives in its own root module, read this one's outputs instead of hardcoding IDs.

- Remote state:

  ```hcl
  data "terraform_remote_state" "base" {
    backend = "s3"
    config = {
      bucket = "ticketmastery-tfstate-<account-id>"
      key    = "envs/dev/terraform.tfstate"
      region = "ap-southeast-1"
    }
  }

  # data.terraform_remote_state.base.outputs.private_subnet_ids
  ```

- CLI / scripts:

  ```bash
  terraform -chdir=infra/envs/dev output -json > base-outputs.json
  terraform -chdir=infra/envs/dev output -raw alb_dns_name
  ```

Shared outputs: `vpc_id`, `vpc_cidr`, `public_subnet_ids`, `private_subnet_ids`, `task_subnet_ids`, `alb_sg_id`, `ecs_sg_id`, `rds_sg_id`, `alb_dns_name`, `alb_arn`, `alb_listener_arn` (HTTPS if a certificate is set, otherwise HTTP), `ecs_cluster_name`, `ecs_service_names` (map: service key → ECS service name), `ecr_repository_url`, `task_role_arn`, `task_role_name`, `log_group_name`, `db_endpoint`, `db_address`, `db_port`, `db_name`, `db_availability_zone`, `db_secret_arn`, `frontend_bucket_name`, `cloudfront_distribution_id`, `cloudfront_domain_name`, `github_deploy_role_arn`.
