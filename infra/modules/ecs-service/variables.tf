variable "name" {
  description = "Name prefix, e.g. ticketmastery-dev."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets (one per AZ) for the internet-facing ALB, and for the Fargate tasks when tasks_in_public_subnets = true."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets (one per AZ) for Fargate tasks when tasks_in_public_subnets = false. Tasks then get no public IP, so these subnets need a NAT route or VPC endpoints (S3 gateway + ecr.api, ecr.dkr, logs, secretsmanager) to pull images, ship logs and read secrets."
  type        = list(string)
}

variable "tasks_in_public_subnets" {
  description = "Implementation/cost mode: run tasks in public_subnet_ids with a public IP so they need no NAT gateway or interface endpoints. Inbound stays limited to the ALB security group. false = HA/production design: tasks in private_subnet_ids, no public IP."
  type        = bool
  default     = false
}

variable "tasks_single_az" {
  description = "Place tasks only in the first subnet (first AZ) of the selected tier. false spreads tasks across every AZ (HA design)."
  type        = bool
  default     = false
}

variable "alb_sg_id" {
  description = "Security group for the ALB."
  type        = string
}

variable "ecs_sg_id" {
  description = "Security group for the Fargate tasks."
  type        = string
}

################################################################################
# Container
################################################################################

variable "container_name" {
  description = "Container name in the task definition (also the ALB target container)."
  type        = string
  default     = "ticketmastery-api"
}

variable "ecr_repository_url" {
  description = "ECR repository URL; image is <url>:<image_tag>."
  type        = string
}

variable "image_tag" {
  description = "Image tag to deploy."
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "Port the API listens on inside the container."
  type        = number
  default     = 3000
}

variable "task_cpu" {
  description = "Default Fargate task CPU units (256 = 0.25 vCPU) for every service whose `services` entry leaves cpu unset."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Default Fargate task memory in MiB (must be valid for the CPU) for every service whose `services` entry leaves memory unset."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture: X86_64 or ARM64. Must match the pushed image (Apple Silicon builds default to ARM64 unless built with --platform linux/amd64)."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "auth_mode" {
  description = "API auth mode. `dev-header` trusts a request header for user identity and is for local/dev only; MUST be `cognito` before anything is exposed to real users."
  type        = string
  default     = "dev-header"

  validation {
    condition     = contains(["dev-header", "cognito"], var.auth_mode)
    error_message = "auth_mode must be dev-header or cognito."
  }
}

variable "run_migrations_on_start" {
  description = "Run SQL migrations (advisory-locked, safe with several tasks) when the container starts."
  type        = bool
  default     = true
}

variable "extra_environment" {
  description = "Additional plain environment variables for the container (e.g. SQS queue URLs, SNS topic ARNs from teammates' modules). Never put secrets here."
  type        = map(string)
  default     = {}
}

variable "enable_container_health_check" {
  description = "Add an ECS container health check that requests /health from inside the container. Requires wget in the image (present in node:*-alpine via busybox)."
  type        = bool
  default     = false
}

################################################################################
# Database
################################################################################

variable "db_host" {
  description = "RDS hostname."
  type        = string
}

variable "db_port" {
  description = "RDS port."
  type        = number
  default     = 5432
}

variable "db_name" {
  description = "Database name."
  type        = string
}

variable "db_secret_arn" {
  description = "ARN of the RDS-managed master user secret (JSON keys username/password)."
  type        = string
}

################################################################################
# ECS service / cluster
################################################################################

variable "services" {
  description = <<-EOT
    One ECS service per use case, keyed by a short service key (service `<name>-<key>`, task family `<name>-<key>`).
    All run the same image; each mounts only its API modules (API_MODULES) and gets its own target group, scaling
    policies and deployments. Fields:
      modules           API module keys to mount (services/ticketmastery-api/src/modules/keys.ts).
      path_patterns     ALB path patterns routed to this service (max 5). Not used for default_service, which gets
                        the listener's default action (everything no rule matches, including /health).
      listener_priority ALB listener rule priority (21-50000, unique, required for every non-default service; 1-20 are
                        auth-apigw's origin_header rules). Keep it fixed once applied.
      tg_short_name     Replaces the key in the target group name `<name>-<tg_short_name>-tg` (max 32 characters).
      desired_count, autoscaling_min, autoscaling_max, cpu, memory
                        Per-service overrides. Unset = desired_count, autoscaling_min_capacity,
                        autoscaling_max_capacity, task_cpu, task_memory.
  EOT
  type = map(object({
    modules           = list(string)
    path_patterns     = optional(list(string), [])
    listener_priority = optional(number)
    tg_short_name     = optional(string)
    desired_count     = optional(number)
    autoscaling_min   = optional(number)
    autoscaling_max   = optional(number)
    cpu               = optional(number)
    memory            = optional(number)
  }))

  validation {
    condition     = length(var.services) > 0 && alltrue([for k, s in var.services : can(regex("^[a-z0-9-]+$", k)) && length(s.modules) > 0])
    error_message = "services needs at least one entry; keys are lowercase letters, digits and hyphens, and every service mounts at least one module."
  }

  # Same list as services/ticketmastery-api/src/modules/keys.ts: a typo fails the plan instead of crash-looping tasks.
  validation {
    condition     = alltrue(flatten([for s in values(var.services) : [for m in s.modules : contains(["discovery", "account", "waiting-room", "checkout", "organiser"], m)]]))
    error_message = "services[*].modules must be API module keys: discovery, account, waiting-room, checkout, organiser."
  }

  validation {
    condition     = alltrue([for s in values(var.services) : length(s.path_patterns) <= 5])
    error_message = "An ALB listener rule takes at most 5 path patterns per service."
  }
}

variable "default_service" {
  description = "Key in `services` that the listener's default action forwards to: unmatched paths and /health (API Gateway's /health probe). Its path_patterns and listener_priority are ignored."
  type        = string
  default     = "discovery"
}

variable "desired_count" {
  description = "Default task count per service (services[*].desired_count overrides). With autoscaling enabled, an apply resets the count to this value and the autoscaler re-adjusts afterwards."
  type        = number
  default     = 1
}

variable "container_insights" {
  description = "ECS cluster Container Insights setting. `enabled` adds CloudWatch metric charges."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["enabled", "disabled"], var.container_insights)
    error_message = "container_insights must be enabled or disabled."
  }
}

variable "enable_execute_command" {
  description = "Allow ECS Exec into the API tasks (needs the task in a subnet that can reach SSM: public IP or NAT/endpoints)."
  type        = bool
  default     = false
}

variable "log_group_name" {
  description = "CloudWatch log group for container logs."
  type        = string
  default     = "/ecs/ticketmastery-api"
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 14
}

################################################################################
# ALB
################################################################################

variable "alb_internal" {
  description = "true = internal ALB in the private subnets, reachable only from inside the VPC (API Gateway VPC link). Changing it replaces the ALB (new DNS name and listener ARNs)."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ACM certificate ARN (same region) for an HTTPS listener. Empty = HTTP only. When set, HTTP redirects to HTTPS."
  type        = string
  default     = ""
}

variable "health_check_path" {
  description = "ALB target group health check path."
  type        = string
  default     = "/health"
}

################################################################################
# Autoscaling
################################################################################

variable "enable_autoscaling" {
  description = "Attach Application Auto Scaling (CPU + ALB request count target tracking) to every service, each with its own min/max."
  type        = bool
  default     = true
}

variable "autoscaling_min_capacity" {
  description = "Default minimum task count when autoscaling (services[*].autoscaling_min overrides)."
  type        = number
  default     = 1
}

variable "autoscaling_max_capacity" {
  description = "Default maximum task count when autoscaling (services[*].autoscaling_max overrides)."
  type        = number
  default     = 4
}

variable "autoscaling_cpu_target" {
  description = "Target average CPU utilisation (%)."
  type        = number
  default     = 60
}

variable "autoscaling_requests_per_target" {
  description = "Target ALB requests per task per minute (ALBRequestCountPerTarget)."
  type        = number
  default     = 500
}
