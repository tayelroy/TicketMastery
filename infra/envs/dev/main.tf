locals {
  name = "${var.project}-${var.environment}"
}

# Implementation vs target (HA) design: see docs/architecture.md.
#
# The network always has 2 public + 2 private subnets (AZ a and AZ b), even in
# the single-AZ implementation mode, because an ALB needs subnets in >= 2 AZs
# and an RDS DB subnet group must span >= 2 AZs (even for a single-AZ
# instance). In implementation mode everything that actually runs (the one API
# task and the DB instance) sits in the first AZ; the AZ b subnets only satisfy
# those AWS requirements (plus the ALB node there).
module "network" {
  source = "../../modules/network"

  name                     = local.name
  vpc_cidr                 = var.vpc_cidr
  enable_nat_gateway       = var.enable_nat_gateway
  single_nat_gateway       = var.single_nat_gateway
  enable_gateway_endpoints = var.enable_gateway_endpoints
  enable_vpc_endpoints     = var.enable_vpc_endpoints
}

module "security" {
  source = "../../modules/security"

  name                     = local.name
  vpc_id                   = module.network.vpc_id
  container_port           = var.container_port
  alb_ingress_cidrs        = var.alb_ingress_cidrs
  enable_https             = var.certificate_arn != ""
  rds_extra_ingress_sg_ids = var.rds_extra_ingress_sg_ids
}

# Project-scoped (not env-scoped) so images can be promoted between environments.
module "ecr" {
  source = "../../modules/ecr"

  repository_name = "${var.project}-api"
  force_delete    = var.ecr_force_delete
}

module "rds" {
  source = "../../modules/rds"

  name                    = local.name
  private_subnet_ids      = module.network.private_subnet_ids
  rds_sg_id               = module.security.rds_sg_id
  engine_version          = var.db_engine_version
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage
  multi_az                = var.db_multi_az
  backup_retention_period = var.db_backup_retention_period
  deletion_protection     = var.db_deletion_protection
  skip_final_snapshot     = var.db_skip_final_snapshot

  # Single-AZ: pin the DB to AZ a, next to the API task (tasks_single_az).
  # Multi-AZ: must be null; RDS rejects availability_zone with multi_az = true
  # (the rds module also enforces this with a precondition).
  availability_zone = var.db_multi_az ? null : module.network.azs[0]
}

module "ecs_service" {
  source = "../../modules/ecs-service"

  name                    = local.name
  vpc_id                  = module.network.vpc_id
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  tasks_in_public_subnets = var.tasks_in_public_subnets
  tasks_single_az         = var.tasks_single_az
  alb_sg_id               = module.security.alb_sg_id
  ecs_sg_id               = module.security.ecs_sg_id

  ecr_repository_url            = module.ecr.repository_url
  image_tag                     = var.image_tag
  container_port                = var.container_port
  task_cpu                      = var.task_cpu
  task_memory                   = var.task_memory
  cpu_architecture              = var.cpu_architecture
  auth_mode                     = var.auth_mode
  run_migrations_on_start       = var.run_migrations_on_start
  enable_container_health_check = var.enable_container_health_check

  db_host       = module.rds.address
  db_port       = module.rds.port
  db_name       = module.rds.db_name
  db_secret_arn = module.rds.master_user_secret_arn

  desired_count      = var.desired_count
  container_insights = var.container_insights
  log_retention_days = var.log_retention_days
  certificate_arn    = var.certificate_arn
  alb_internal       = var.alb_internal

  # Public identifiers for AUTH_MODE=cognito (not secrets). Teammates add their non-secret values here too.
  extra_environment = {
    COGNITO_USER_POOL_ID = module.auth_apigw.user_pool_id
    COGNITO_CLIENT_ID    = module.auth_apigw.user_pool_client_id
  }

  enable_autoscaling       = var.enable_autoscaling
  autoscaling_min_capacity = var.autoscaling_min_capacity
  autoscaling_max_capacity = var.autoscaling_max_capacity
}

# Warning only (check blocks never fail the run). Tasks in public subnets use
# their public IP for egress. Tasks in private subnets have no public IP, so
# they need NAT, or the S3 gateway endpoint plus interface endpoints, to pull
# from ECR, write logs and read the DB secret.
check "task_egress" {
  assert {
    condition     = var.tasks_in_public_subnets || var.enable_nat_gateway || (var.enable_vpc_endpoints && var.enable_gateway_endpoints)
    error_message = "tasks_in_public_subnets = false (private subnets, no public IP) needs enable_nat_gateway = true, or both enable_vpc_endpoints and enable_gateway_endpoints; otherwise ECS tasks cannot pull images, ship logs or read secrets and will fail to start."
  }
}

# Edge infrastructure - Cody
# S3, CloudFront, and AWS WAF
module "edge" {
  source = "../../modules/edge"

  name = local.name

  # CloudFront sends /api/* and /health to API Gateway.
  api_gateway_domain = module.auth_apigw.api_domain

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  tags = {
    Owner = "cody"
  }
}

# GitHub Actions deployment permissions - Cody
module "github_deploy" {
  source = "../../modules/github-deploy"

  name = local.name

  github_oidc_subject = "repo:tayelroy@23186072/TicketMastery@1423019527"

  frontend_bucket_arn = module.edge.frontend_bucket_arn

  cloudfront_distribution_arn = module.edge.cloudfront_distribution_arn
}

# SQS FIFO join-queue + DLQ, DynamoDB live-queue, queue-manager Lambda.
# The Lambda runs in the private subnets and reaches DynamoDB via the gateway endpoint.
module "waiting_room" {
  source = "../../modules/waiting-room"

  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
}

# Auth (Cognito) + API Gateway - Andrew
module "auth_apigw" {
  source = "../../modules/auth-apigw"

  name               = local.name
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  alb_sg_id          = module.security.alb_sg_id

  # vpc_link (option B, default): integrate with the HTTP :80 listener of the (internal) ALB.
  # origin_header (option A): rules on the HTTPS :443 listener + public HTTPS to alb_origin_domain.
  alb_integration      = var.alb_integration
  alb_listener_arn     = var.alb_integration == "vpc_link" ? module.ecs_service.http_listener_arn : module.ecs_service.https_listener_arn
  alb_listener_port    = var.alb_integration == "vpc_link" ? 80 : 443
  alb_origin_domain    = var.alb_origin_domain
  api_target_group_arn = module.ecs_service.target_group_arn

  waiting_room_public = var.waiting_room_public
}

# Warning only. vpc_link needs the internal ALB (its ENIs sit in private subnets with no NAT, so they can't reach an
# internet-facing ALB's public IPs) and the plain HTTP listener: with a certificate, :80 redirects to HTTPS and the
# VPC link would get 301s. origin_header needs a public ALB, the HTTPS listener (certificate) and its own DNS name.
check "auth_apigw_alb_integration" {
  assert {
    condition = (
      (var.alb_integration == "vpc_link" && var.alb_internal && var.certificate_arn == "") ||
      (var.alb_integration == "origin_header" && !var.alb_internal && var.certificate_arn != "" && var.alb_origin_domain != "")
    )
    error_message = "alb_integration = vpc_link needs alb_internal = true and certificate_arn = \"\"; origin_header needs alb_internal = false, certificate_arn and alb_origin_domain."
  }
}
