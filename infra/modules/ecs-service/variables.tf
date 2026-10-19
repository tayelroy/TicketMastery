variable "name" {
  description = "Name prefix, e.g. ticketmastery-dev."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID for the target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the internet-facing ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Private subnets for Fargate tasks. Tasks get no public IP, so these subnets need a NAT route or VPC endpoints (S3 gateway + ecr.api, ecr.dkr, logs, secretsmanager) to pull images, ship logs and read secrets."
  type        = list(string)
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
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB (must be valid for task_cpu)."
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

variable "desired_count" {
  description = "Number of tasks. With autoscaling enabled, an apply resets the count to this value and the autoscaler re-adjusts afterwards."
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
  description = "Attach Application Auto Scaling (CPU + ALB request count target tracking)."
  type        = bool
  default     = true
}

variable "autoscaling_min_capacity" {
  description = "Minimum task count when autoscaling."
  type        = number
  default     = 1
}

variable "autoscaling_max_capacity" {
  description = "Maximum task count when autoscaling."
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
