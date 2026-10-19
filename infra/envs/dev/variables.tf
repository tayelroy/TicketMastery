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
  description = "Create NAT gateway(s) for private subnet egress (~USD 45/month each)."
  type        = bool
  default     = true
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
  description = "IPv4 CIDRs allowed to reach the ALB."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "rds_extra_ingress_sg_ids" {
  description = "Extra security group IDs (e.g. teammates' VPC Lambdas) allowed to reach RDS on 5432."
  type        = list(string)
  default     = []
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
  description = "Fargate task CPU units."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 512
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture (X86_64 or ARM64); must match the pushed image."
  type        = string
  default     = "X86_64"
}

variable "desired_count" {
  description = "Number of API tasks."
  type        = number
  default     = 1
}

variable "run_migrations_on_start" {
  description = "Run the API's SQL migrations when each task starts."
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

variable "log_retention_days" {
  description = "API log retention (days)."
  type        = number
  default     = 14
}

variable "enable_autoscaling" {
  description = "Enable ECS service autoscaling on CPU and ALB request count."
  type        = bool
  default     = true
}

variable "autoscaling_max_capacity" {
  description = "Maximum API task count when autoscaling."
  type        = number
  default     = 4
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
