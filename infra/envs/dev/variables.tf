variable "aws_region" {
  description = "AWS region."
  type        = string
  default     = "ap-southeast-1"
}

variable "project" {
  description = "Project name prefix."
  type        = string
  default     = "ticketmastery"
}

variable "environment" {
  description = "Environment name; also the Environment default tag."
  type        = string
  default     = "dev"
}

################################################################################
# Network
################################################################################

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.20.0.0/16"
}

variable "enable_nat_gateway" {
  description = "Create NAT gateway(s) for private-subnet egress (~USD 43/month each + USD 0.059/GB). Needed only when tasks_in_public_subnets = false (unless enable_vpc_endpoints covers it) or for in-VPC Lambdas that call AWS APIs/the internet."
  type        = bool
  default     = false
}

variable "single_nat_gateway" {
  description = "Use one NAT in the first AZ instead of one per AZ."
  type        = bool
  default     = true
}

variable "enable_gateway_endpoints" {
  description = "Create free S3 + DynamoDB gateway endpoints."
  type        = bool
  default     = true
}

variable "enable_vpc_endpoints" {
  description = "Create paid interface endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs)."
  type        = bool
  default     = false
}

################################################################################
# Security
################################################################################

variable "alb_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach the ALB. Empty for the internal ALB (alb_internal = true); the VPC link reaches it through its own security group rule."
  type        = list(string)
  default     = []
}

variable "rds_extra_ingress_sg_ids" {
  description = "Extra security group IDs (e.g. teammates' VPC Lambdas) allowed to reach RDS on 5432."
  type        = list(string)
  default     = []
}

variable "alb_internal" {
  description = "Internal ALB in the private subnets (true with alb_integration = vpc_link). When true, also set alb_ingress_cidrs = []."
  type        = bool
  default     = true
}

variable "certificate_arn" {
  description = "ACM certificate ARN in aws_region for the ALB HTTPS listener. Empty = HTTP only."
  type        = string
  default     = ""
}

################################################################################
# ECR / ECS
################################################################################

variable "ecr_force_delete" {
  description = "Allow destroying the ECR repository while it still holds images."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "ticketmastery-api image tag to deploy."
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "ticketmastery-api container port."
  type        = number
  default     = 3000
}

variable "task_cpu" {
  description = "Default Fargate task CPU units for every ECS service (ecs_services[*].cpu overrides)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Default Fargate task memory (MiB) for every ECS service (ecs_services[*].memory overrides)."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture (X86_64 or ARM64); must match the pushed image."
  type        = string
  default     = "X86_64"
}

variable "tasks_in_public_subnets" {
  description = "Implementation/cost mode: run API tasks in the public subnets with a public IP (egress without NAT). Inbound still only from the ALB SG. false = HA design: private subnets, egress via NAT or interface endpoints."
  type        = bool
  default     = true
}

variable "tasks_single_az" {
  description = "Run API tasks only in the first AZ (implementation mode). false spreads tasks across both AZs (HA design)."
  type        = bool
  default     = true
}

variable "ecs_services" {
  description = <<-EOT
    One ECS service per use case (all from the same image; API_MODULES selects the routes). Key = service key
    (ECS service ticketmastery-dev-<key>). discovery is the ALB default (unmatched paths and /health); the others
    need path_patterns and a fixed listener_priority (> 20). Unset desired_count / autoscaling_min / cpu / memory /
    autoscaling_max fall back to desired_count, autoscaling_min_capacity, task_cpu, task_memory,
    autoscaling_max_capacity; values set here win over those. See infra/README.md.
    db_user picks the database login: "master" (the RDS-managed master secret, default) or "reporting_ro" (the
    read-only reporting role's secret, module.rds); main.tf turns it into the service's db_secret_arn, because a
    variable default cannot reference a resource ARN. run_migrations_on_start and extra_environment override the
    globals of the same name per service (extra_environment is merged over the global one).
  EOT
  type = map(object({
    modules                 = list(string)
    path_patterns           = optional(list(string), [])
    listener_priority       = optional(number)
    tg_short_name           = optional(string)
    desired_count           = optional(number)
    autoscaling_min         = optional(number)
    autoscaling_max         = optional(number)
    cpu                     = optional(number)
    memory                  = optional(number)
    db_user                 = optional(string, "master")
    run_migrations_on_start = optional(bool)
    extra_environment       = optional(map(string), {})
  }))
  default = {
    # UC1 browse + seat map: the read-heavy path, first to need more tasks at an on-sale.
    discovery = {
      modules         = ["discovery"]
      autoscaling_max = 3
    }
    # UC2 my tickets and account.
    account = {
      modules           = ["account"]
      path_patterns     = ["/api/me", "/api/me/*"]
      listener_priority = 110
      autoscaling_max   = 2
    }
    # UC3 waiting room; "wroom" keeps the target group name within 32 characters.
    waiting-room = {
      modules           = ["waiting-room"]
      path_patterns     = ["/api/waiting-room", "/api/waiting-room/*"]
      listener_priority = 120
      tg_short_name     = "wroom"
      autoscaling_max   = 3
    }
    # UC4 seat holds and checkout.
    checkout = {
      modules           = ["checkout"]
      path_patterns     = ["/api/checkout", "/api/checkout/*"]
      listener_priority = 130
      autoscaling_max   = 3
    }
    # UC5 organiser concert management.
    organiser = {
      modules           = ["organiser"]
      path_patterns     = ["/api/organiser", "/api/organiser/*"]
      listener_priority = 140
      autoscaling_max   = 2
    }
    # UC5 sales reports, live from the report_* views, as the read-only reporting_ro role: it can SELECT those five
    # views and nothing else, so it cannot run migrations. Its connection limit is 10: 2 tasks x DB_POOL_MAX 4 = 8,
    # leaving 2 for reporting-user.sh checks or psql. (During a deployment old and new tasks overlap, but a pool only
    # opens connections that concurrent requests need and closes idle ones after 30s; over the limit a request
    # fails, the task does not.)
    reporting = {
      modules                 = ["reporting"]
      path_patterns           = ["/api/reports", "/api/reports/*"]
      listener_priority       = 150
      autoscaling_max         = 2
      db_user                 = "reporting_ro"
      run_migrations_on_start = false
      extra_environment       = { DB_POOL_MAX = "4" }
    }
  }

  validation {
    condition     = alltrue([for s in values(var.ecs_services) : contains(["master", "reporting_ro"], s.db_user)])
    error_message = "ecs_services[*].db_user must be \"master\" or \"reporting_ro\"."
  }
}

variable "desired_count" {
  description = "Default task count for every ECS service (ecs_services[*].desired_count overrides)."
  type        = number
  default     = 1
}

variable "run_migrations_on_start" {
  description = "Run the API's SQL migrations when each task starts (every service whose ecs_services entry doesn't override it; advisory-locked, so only one task applies them)."
  type        = bool
  default     = true
}

variable "auth_mode" {
  description = "API auth mode: dev-header (dev only) or cognito. Must be cognito before real users."
  type        = string
  default     = "dev-header"
}

variable "enable_container_health_check" {
  description = "Add an in-container /health check to the task definition."
  type        = bool
  default     = false
}

variable "container_insights" {
  description = "ECS Container Insights: enabled or disabled."
  type        = string
  default     = "disabled"
}

variable "enable_execute_command" {
  description = "ECS Exec into the API task (team admins only, via IAM). Used for checks against RDS from inside the VPC."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "API log retention (days)."
  type        = number
  default     = 14
}

variable "enable_autoscaling" {
  description = "Enable autoscaling on CPU and ALB request count for every ECS service, each with its own min/max. Off for the implementation; on in the HA design."
  type        = bool
  default     = false
}

variable "autoscaling_min_capacity" {
  description = "Default minimum task count per service when autoscaling (ecs_services[*].autoscaling_min overrides). Use 2 in the HA design so scale-in never drops below one task per AZ."
  type        = number
  default     = 1
}

variable "autoscaling_max_capacity" {
  description = "Default maximum task count when autoscaling, for services whose ecs_services entry sets no autoscaling_max (the dev defaults set it for all six)."
  type        = number
  default     = 2
}

################################################################################
# RDS
################################################################################

variable "db_engine_version" {
  description = "PostgreSQL version (major-only lets AWS choose the minor)."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS gp3 storage (GiB)."
  type        = number
  default     = 20
}

variable "db_multi_az" {
  description = "Enable RDS Multi-AZ standby."
  type        = bool
  default     = false
}

variable "db_backup_retention_period" {
  description = "Automated backup retention (days)."
  type        = number
  default     = 1
}

variable "db_deletion_protection" {
  description = "Protect the DB instance from deletion."
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "Skip the final snapshot when destroying the DB."
  type        = bool
  default     = true
}

################################################################################
# Auth + API Gateway (Andrew)
################################################################################

variable "alb_integration" {
  description = "How API Gateway reaches the ALB: vpc_link (internal ALB, recommended) or origin_header (public ALB + secret header; needs certificate_arn and alb_origin_domain)."
  type        = string
  default     = "vpc_link"

  validation {
    condition     = contains(["vpc_link", "origin_header"], var.alb_integration)
    error_message = "alb_integration must be vpc_link or origin_header."
  }
}

variable "alb_origin_domain" {
  description = "origin_header only: DNS name pointing at the ALB that matches certificate_arn, e.g. origin.example.com."
  type        = string
  default     = ""
}

variable "waiting_room_public" {
  description = "true lets guests (no token) call /api/waiting-room; false (default) requires sign-in."
  type        = bool
  default     = false
}

variable "admit_schedule_enabled" {
  description = "UC3: run the queue-manager admit step every minute (EventBridge Scheduler)."
  type        = bool
  default     = true
}

variable "admit_schedule_start_date" {
  description = "UC3: optional RFC 3339 start of the admit schedule, to limit it to a sale window (null = no limit)."
  type        = string
  default     = null
}

variable "admit_schedule_end_date" {
  description = "UC3: optional RFC 3339 end of the admit schedule (null = no limit)."
  type        = string
  default     = null
}

variable "admit_batch_size" {
  description = "UC3: fans admitted per concert per admit run (once a minute)."
  type        = number
  default     = 500
}

variable "ticket_fallback_recipient_email" {
  description = "Testing only: verified SES address that ticket-fn emails when a fan has no Cognito user (dev-header ids). Empty = off."
  type        = string
  default     = ""
}

variable "contact_email" {
  description = "Team contact: SES sender of the e-ticket emails (must be verified), alert emails and AWS Budgets notifications."
  type        = string
  default     = "tayelroy@gmail.com"
}
