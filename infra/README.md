# TicketMastery infra

Terraform for the shared base: VPC, security groups, ECR, RDS PostgreSQL, and the `ticketmastery-api` ECS Fargate service behind an ALB. Region `ap-southeast-1`.

## Layout

```
infra/
├── envs/dev/            root module: wires the modules, owns state
│   ├── versions.tf      terraform >= 1.6, aws ~> 5.0, random ~> 3.6
│   ├── providers.tf     region + default tags (no profile; use AWS_PROFILE)
│   ├── backend.tf       local state + commented S3/DynamoDB backend
│   ├── main.tf          module wiring
│   ├── variables.tf / outputs.tf / terraform.tfvars.example
└── modules/
    ├── network/         VPC 10.20.0.0/16, 2 public + 2 private subnets, IGW, NAT, endpoints
    ├── security/        alb_sg -> ecs_sg -> rds_sg chain
    ├── ecr/             ticketmastery-api repo, scan on push, keep last 10 images
    ├── rds/             PostgreSQL 16, db.t4g.micro, password managed in Secrets Manager
    └── ecs-service/     log group, cluster, IAM roles, task def, ALB, service, autoscaling
```

| Module | Key outputs |
|---|---|
| network | `vpc_id`, `vpc_cidr`, `public_subnet_ids`, `private_subnet_ids`, `private_route_table_ids` |
| security | `alb_sg_id`, `ecs_sg_id`, `rds_sg_id` |
| ecr | `repository_url` |
| rds | `address`, `port`, `db_name`, `master_user_secret_arn` |
| ecs-service | `alb_dns_name`, `http_listener_arn`, `https_listener_arn`, `cluster_name`, `service_name`, `task_role_name`, `task_role_arn` |

## Usage

```bash
export AWS_PROFILE=<your-profile>
cd infra/envs/dev
cp terraform.tfvars.example terraform.tfvars   # gitignored; edit as needed
terraform init
terraform plan
```

Only one person applies `dev` while state is local. Switch to the S3 backend in `backend.tf` once the bucket and lock table exist.

### Cost toggles

| Variable | Default | Effect |
|---|---|---|
| `enable_nat_gateway` | `true` | NAT for private-subnet egress (~USD 45/month each) |
| `single_nat_gateway` | `true` | one NAT in AZ a instead of one per AZ |
| `enable_gateway_endpoints` | `true` | S3 + DynamoDB gateway endpoints (free) |
| `enable_vpc_endpoints` | `false` | interface endpoints ecr.api, ecr.dkr, logs, secretsmanager, sqs (~USD 95/month) |
| `db_multi_az` | `false` | RDS standby in a second AZ |
| `container_insights` | `disabled` | ECS Container Insights metrics |

ECS tasks have no public IP. With NAT disabled they need **both** gateway and interface endpoints, otherwise they can't pull images, ship logs, or read the DB secret. A `check` block in `envs/dev/main.tf` warns about this.

### Database credentials

RDS generates the master password and stores it in Secrets Manager (`db_secret_arn`, JSON keys `username` and `password`). The password never appears in code or state. ECS gets the values as `DB_USER` and `DB_PASSWORD` through task definition `secrets`. Lambdas should read the secret at runtime, using an IAM policy that allows `secretsmanager:GetSecretValue` on that ARN.

### Deploying a new image

The task definition uses `<ecr_repository_url>:<image_tag>`. You can push a new tag and set `image_tag`, then apply. Or you can re-push `latest` and run `aws ecs update-service --cluster <ecs_cluster_name> --service <ecs_service_name> --force-new-deployment`. The deployment circuit breaker rolls back failed deployments.

`auth_mode` defaults to `dev-header` for development. It **must** be switched to `cognito` once the Cognito/API Gateway authorizer is live.

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

4. A Lambda that needs RDS should run in `private_subnet_ids` with its own SG. Add that SG to RDS ingress by setting `rds_extra_ingress_sg_ids = [module.waiting_room.lambda_sg_id]` in the `security` module call. That setting is a root variable, so you can also put it in tfvars.
5. To give the API a queue URL or ARN, set `extra_environment = { JOIN_QUEUE_URL = module.waiting_room.join_queue_url }` on the `ecs_service` module. Only non-secret values belong there.
6. Add any outputs others need to `envs/dev/outputs.tf`, each with a `description`.
7. Run `terraform fmt -recursive infra && terraform -chdir=infra/envs/dev validate` before opening a PR.

## Consuming outputs from a separate stack

If your stack lives in its own root module, read this one's outputs instead of hardcoding IDs.

- Remote state (after the S3 backend is enabled):

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

Shared outputs: `vpc_id`, `vpc_cidr`, `public_subnet_ids`, `private_subnet_ids`, `alb_sg_id`, `ecs_sg_id`, `rds_sg_id`, `alb_dns_name`, `alb_arn`, `alb_listener_arn` (HTTPS if a certificate is set, otherwise HTTP), `ecs_cluster_name`, `ecs_service_name`, `ecr_repository_url`, `task_role_arn`, `task_role_name`, `log_group_name`, `db_endpoint`, `db_address`, `db_port`, `db_name`, `db_secret_arn`.
