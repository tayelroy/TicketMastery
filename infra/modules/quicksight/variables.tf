variable "name" {
  description = "Name prefix, e.g. ticketmastery-dev. Resource names and QuickSight ids start with it."
  type        = string
}

################################################################################
# Account
################################################################################

variable "account_name" {
  description = "QuickSight account name: unique across all of AWS, shown at sign-in, cannot be changed (a change replaces the subscription, deleting every QuickSight asset)."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-Za-z]+(-*[0-9A-Za-z])*$", var.account_name)) && !startswith(lower(var.account_name), "d-") && length(var.account_name) <= 62
    error_message = "account_name: letters, digits and inner hyphens, at most 62 characters, not starting with d- (CreateAccountSubscription rules)."
  }
}

variable "notification_email" {
  description = "Email for QuickSight account and subscription notices; also the admin user's email."
  type        = string
}

variable "admin_iam_arn" {
  description = "IAM user registered as the QuickSight ADMIN; owns the data source, datasets and dashboard."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:user/", var.admin_iam_arn))
    error_message = "admin_iam_arn must be an IAM user ARN (arn:aws:iam::<account>:user/<name>)."
  }
}

variable "register_admin_user" {
  description = "Register admin_iam_arn with aws_quicksight_user. Set false when admin_iam_arn is the identity running Terraform: CreateAccountSubscription already registers the caller as ADMIN, and the user resource would then fail with ResourceExistsException."
  type        = bool
  default     = true
}

################################################################################
# Network
################################################################################

variable "vpc_id" {
  description = "VPC of the RDS instance."
  type        = string
}

variable "subnet_ids" {
  description = "Subnets for the VPC connection's network interfaces (at least 2; the private subnets)."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "A QuickSight VPC connection needs at least two subnets."
  }
}

variable "rds_sg_id" {
  description = "Security group of the RDS instance; this module adds an ingress rule on it from the QuickSight SG."
  type        = string
}

################################################################################
# Database
################################################################################

variable "db_host" {
  description = "RDS hostname (no port)."
  type        = string
}

variable "db_port" {
  description = "RDS port."
  type        = number
  default     = 5432
}

variable "db_name" {
  description = "Database holding the report_* views."
  type        = string
}

variable "db_schema" {
  description = "Schema of the report_* views (the API migrates into public)."
  type        = string
  default     = "public"
}

variable "reporting_secret_name" {
  description = "Secrets Manager secret {\"username\", \"password\"} for the reporting_ro role, written by loadtest/scripts/reporting-user.sh. Looked up by name; Terraform never reads its value."
  type        = string
}

variable "secret_access_granted" {
  description = "Create the data source, datasets and dashboard. Set true only after granting QuickSight access to reporting_secret_name in the console (Manage QuickSight > Security & permissions); without it, creating the data source fails with access denied."
  type        = bool
  default     = false
}

################################################################################
# Dashboard
################################################################################

variable "currency" {
  description = "Currency the dashboard shows. Every visual is filtered to it, because amounts are never added across currencies (docs/reporting.md)."
  type        = string
  default     = "SGD"

  validation {
    condition     = can(regex("^[A-Z]{3}$", var.currency))
    error_message = "currency must be a 3-letter ISO code, e.g. SGD."
  }
}
