output "alerts_topic_arn" {
  description = "SNS alerts topic ARN; pass to other modules' alarms as alarm_actions/ok_actions (e.g. messaging alarm_actions)."
  value       = aws_sns_topic.alerts.arn
}

output "dashboard_name" {
  description = "CloudWatch dashboard name."
  value       = aws_cloudwatch_dashboard.this.dashboard_name
}

output "dashboard_url" {
  description = "CloudWatch console URL of the dashboard."
  value       = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.this.dashboard_name}"
}

output "alarm_names" {
  description = "Names of every alarm this module creates."
  value       = local.alarms[*].alarm_name
}

output "budget_name" {
  description = "AWS Budgets monthly cost budget name."
  value       = aws_budgets_budget.monthly.name
}
