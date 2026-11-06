output "account_name" {
  description = "QuickSight account name (asked for at sign-in)."
  value       = aws_quicksight_account_subscription.this.account_name
}

output "admin_principal_arn" {
  description = "QuickSight user ARN that owns the data source, datasets and dashboard."
  value       = local.admin_principal
}

output "security_group_id" {
  description = "Security group of the VPC connection's network interfaces."
  value       = aws_security_group.quicksight.id
}

output "vpc_connection_arn" {
  description = "QuickSight VPC connection ARN."
  value       = aws_quicksight_vpc_connection.this.arn
}

output "data_source_arn" {
  description = "PostgreSQL data source ARN (null until secret_access_granted = true)."
  value       = one(aws_quicksight_data_source.postgres[*].arn)
}

output "data_set_arns" {
  description = "Dataset ARN per report_* view, keyed by view name without the report_ prefix (empty until secret_access_granted = true)."
  value       = { for key, data_set in aws_quicksight_data_set.this : key => data_set.arn }
}

output "dashboard_id" {
  description = "Sales dashboard id (null until secret_access_granted = true)."
  value       = one(aws_quicksight_dashboard.sales[*].dashboard_id)
}

output "dashboard_url" {
  description = "Console URL of the Sales dashboard (sign in as the admin IAM user first)."
  value       = var.secret_access_granted ? "https://${local.region}.quicksight.aws.amazon.com/sn/dashboards/${aws_quicksight_dashboard.sales[0].dashboard_id}" : null
}

output "reporting_secret_name" {
  description = "Secrets Manager secret to grant QuickSight access to (Manage QuickSight > Security & permissions)."
  value       = var.reporting_secret_name
}
