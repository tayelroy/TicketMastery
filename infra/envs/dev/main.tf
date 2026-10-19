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
