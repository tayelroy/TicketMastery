output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.api.name
}

output "task_definition_arn" {
  description = "Current task definition ARN (with revision)."
  value       = aws_ecs_task_definition.api.arn
}

output "alb_arn" {
  description = "ALB ARN."
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "ALB DNS name."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  description = "ALB canonical hosted zone ID (for Route 53 alias records)."
  value       = aws_lb.this.zone_id
}

output "http_listener_arn" {
  description = "HTTP :80 listener ARN."
  value       = aws_lb_listener.http.arn
}

output "https_listener_arn" {
  description = "HTTPS :443 listener ARN, or null when no certificate is configured."
  value       = local.enable_https ? aws_lb_listener.https[0].arn : null
}

output "target_group_arn" {
  description = "API target group ARN."
  value       = aws_lb_target_group.api.arn
}

output "log_group_name" {
  description = "CloudWatch log group for API container logs."
  value       = aws_cloudwatch_log_group.api.name
}

output "task_role_arn" {
  description = "IAM role ARN the API code runs as."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "IAM role name the API code runs as; attach teammates' policies here."
  value       = aws_iam_role.task.name
}

output "execution_role_arn" {
  description = "ECS task execution role ARN."
  value       = aws_iam_role.execution.arn
}
