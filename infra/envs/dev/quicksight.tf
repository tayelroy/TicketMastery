# UC5 internal reporting: Amazon QuickSight over the report_* views (infra/modules/quicksight, docs/reporting.md).
# Off by default: the subscription is billed per user per month. Steps, cost and teardown in the module README.
# Variables and outputs live here too, so the QuickSight wiring stays in one file.

################################################################################
# Variables
################################################################################

variable "enable_quicksight" {
  description = "Subscribe to QuickSight Enterprise and create the VPC connection to RDS. Billed per user per month while subscribed (module README)."
  type        = bool
  default     = false
}

variable "quicksight_secret_access_granted" {
  description = "Second apply: create the data source, datasets and dashboard. Set true only after granting QuickSight access to the reporting secret in the console (module README, step 4)."
  type        = bool
  default     = false
}

variable "quicksight_account_name" {
  description = "QuickSight account name, unique across all of AWS and fixed once subscribed. null = <project>-<environment>-<AWS account id>."
  type        = string
  default     = null
}

variable "quicksight_admin_iam_arn" {
  description = "IAM user registered as the QuickSight ADMIN and owner of every QuickSight asset."
  type        = string
  default     = "arn:aws:iam::000246635159:user/elroy"
}

variable "quicksight_register_admin_user" {
  description = "false when quicksight_admin_iam_arn is the identity running Terraform (the subscription registers it itself)."
  type        = bool
  default     = true
}

variable "quicksight_currency" {
  description = "Currency the Sales dashboard shows (amounts are never added across currencies)."
  type        = string
  default     = "SGD"
}

################################################################################
# Module
################################################################################

data "aws_caller_identity" "quicksight" {}

module "quicksight" {
  source = "../../modules/quicksight"
  count  = var.enable_quicksight ? 1 : 0

  name                = local.name
  account_name        = coalesce(var.quicksight_account_name, "${local.name}-${data.aws_caller_identity.quicksight.account_id}")
  notification_email  = var.contact_email
  admin_iam_arn       = var.quicksight_admin_iam_arn
  register_admin_user = var.quicksight_register_admin_user

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  rds_sg_id  = module.security.rds_sg_id

  db_host = module.rds.address
  db_port = module.rds.port
  db_name = module.rds.db_name
  # Written by loadtest/scripts/reporting-user.sh (SECRET_NAME there defaults to the same name).
  reporting_secret_name = "${local.name}/quicksight/reporting-ro"
  secret_access_granted = var.quicksight_secret_access_granted
  currency              = var.quicksight_currency
}

################################################################################
# Outputs
################################################################################

output "quicksight_account_name" {
  description = "QuickSight account name to enter at sign-in (null while enable_quicksight = false)."
  value       = one(module.quicksight[*].account_name)
}

output "quicksight_reporting_secret_name" {
  description = "Secret to grant QuickSight access to in the console before setting quicksight_secret_access_granted = true."
  value       = one(module.quicksight[*].reporting_secret_name)
}

output "quicksight_data_source_arn" {
  description = "QuickSight PostgreSQL data source ARN (null until the second apply)."
  value       = one(module.quicksight[*].data_source_arn)
}

output "quicksight_dashboard_id" {
  description = "QuickSight Sales dashboard id (null until the second apply)."
  value       = one(module.quicksight[*].dashboard_id)
}

output "quicksight_dashboard_url" {
  description = "QuickSight Sales dashboard URL (null until the second apply)."
  value       = one(module.quicksight[*].dashboard_url)
}
