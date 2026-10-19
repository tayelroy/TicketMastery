variable "name" {
  description = "Name prefix for security groups, e.g. ticketmastery-dev."
  type        = string
}

variable "vpc_id" {
  description = "VPC the security groups belong to."
  type        = string
}

variable "container_port" {
  description = "Port the ticketmastery-api container listens on (ALB -> ECS)."
  type        = number
  default     = 3000
}

variable "db_port" {
  description = "PostgreSQL port (ECS -> RDS)."
  type        = number
  default     = 5432
}

variable "alb_ingress_cidrs" {
  description = "IPv4 CIDRs allowed to reach the ALB on 80/443."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = alltrue([for c in var.alb_ingress_cidrs : can(cidrhost(c, 0))])
    error_message = "alb_ingress_cidrs must contain valid IPv4 CIDR blocks."
  }
}

variable "enable_https" {
  description = "Open 443 on the ALB SG. Set true when an ACM certificate is attached to the ALB."
  type        = bool
  default     = false
}

variable "rds_extra_ingress_sg_ids" {
  description = "Additional security group IDs (e.g. teammates' VPC Lambdas) allowed to reach RDS on db_port."
  type        = list(string)
  default     = []
}
