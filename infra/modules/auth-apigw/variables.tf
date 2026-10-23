variable "name" {
  description = "Name prefix, e.g. ticketmastery-dev."
  type        = string
}

variable "tags" {
  description = "Extra tags for this module's resources."
  type        = map(string)
  default     = { Owner = "andrew" }
}

################################################################################
# Cognito
################################################################################

variable "user_pool_tier" {
  description = "Cognito feature plan: LITE (cheapest above the 10,000 MAU free tier), ESSENTIALS or PLUS."
  type        = string
  default     = "LITE"

  validation {
    condition     = contains(["LITE", "ESSENTIALS", "PLUS"], var.user_pool_tier)
    error_message = "user_pool_tier must be LITE, ESSENTIALS or PLUS."
  }
}

################################################################################
# API Gateway -> ALB
################################################################################

variable "alb_integration" {
  description = <<-EOT
    How API Gateway reaches the ALB.
    "vpc_link": private integration through an HTTP API VPC link (option B, recommended). The ALB should be internal
      (base stack alb_internal = true); alb_listener_arn is its HTTP listener.
    "origin_header": public HTTPS integration to alb_origin_domain plus a secret x-origin-verify header that ALB listener
      rules require (option A). Needs a domain + ACM certificate on the ALB; alb_listener_arn is its HTTPS listener.
  EOT
  type        = string
  default     = "vpc_link"

  validation {
    condition     = contains(["vpc_link", "origin_header"], var.alb_integration)
    error_message = "alb_integration must be vpc_link or origin_header."
  }
}

variable "vpc_id" {
  description = "VPC ID (vpc_link mode: for the VPC link security group)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets, one per AZ (vpc_link mode: where the VPC link ENIs live)."
  type        = list(string)
}

variable "alb_sg_id" {
  description = "ALB security group ID (vpc_link mode: gets an ingress rule from the VPC link SG)."
  type        = string
}

variable "alb_listener_arn" {
  description = "ALB listener ARN. vpc_link: the HTTP :80 listener (integration target). origin_header: the HTTPS :443 listener (gets the header rules)."
  type        = string
}

variable "alb_listener_port" {
  description = "Port of alb_listener_arn (vpc_link mode: opened from the VPC link SG to the ALB SG)."
  type        = number
  default     = 80
}

variable "alb_origin_domain" {
  description = "origin_header mode only: DNS name that points at the ALB and matches its ACM certificate, e.g. origin.example.com."
  type        = string
  default     = ""
}

variable "api_target_group_arn" {
  description = "origin_header mode only: the API target group the header rule forwards to (module.ecs_service.target_group_arn)."
  type        = string
  default     = ""
}

################################################################################
# Routes, throttling, logs
################################################################################

variable "waiting_room_public" {
  description = "true lets guests (no token) call /api/waiting-room; false (default) requires a Cognito access token."
  type        = bool
  default     = false
}

variable "extra_public_routes" {
  description = "Additional route keys that need no token, e.g. [\"GET /api/venues/{proxy+}\"]. Unlisted paths get API Gateway's 404."
  type        = list(string)
  default     = []
}

variable "extra_protected_routes" {
  description = "Additional route keys that need a valid Cognito access token, e.g. [\"ANY /api/new-feature/{proxy+}\"]."
  type        = list(string)
  default     = []
}

variable "throttling_rate_limit" {
  description = "Stage-wide steady-state requests per second (protects the single 0.25 vCPU task)."
  type        = number
  default     = 100
}

variable "throttling_burst_limit" {
  description = "Stage-wide burst limit."
  type        = number
  default     = 200
}

variable "log_retention_days" {
  description = "API Gateway access-log retention (days)."
  type        = number
  default     = 14
}
