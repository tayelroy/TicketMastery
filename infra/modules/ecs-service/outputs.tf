output "task_subnet_ids" {
  description = "Subnets the ECS service places tasks in (public or private tier, one or all AZs depending on tasks_in_public_subnets / tasks_single_az)."
  value       = local.task_subnet_ids
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "services" {
  description = "Per service key: ECS service name, task definition ARN, target group ARN and ARN suffix (TargetGroup metric dimension), desired count and autoscaling min/max (as applied when enable_autoscaling = true)."
  value = {
    for k, s in local.services : k => {
      service_name             = aws_ecs_service.this[k].name
      task_definition_arn      = aws_ecs_task_definition.this[k].arn
      target_group_arn         = aws_lb_target_group.this[k].arn
      target_group_arn_suffix  = aws_lb_target_group.this[k].arn_suffix
      desired_count            = s.desired_count
      autoscaling_min_capacity = s.autoscaling_min
      autoscaling_max_capacity = s.autoscaling_max
    }
  }
}

output "service_names" {
  description = "ECS service name per service key."
  value       = { for k, s in aws_ecs_service.this : k => s.name }
}

output "default_service" {
  description = "Key of the service behind the listener's default action (unmatched paths and /health)."
  value       = var.default_service
}

output "default_target_group_arn" {
  description = "Target group ARN of default_service."
  value       = aws_lb_target_group.this[var.default_service].arn
}

output "path_routes" {
  description = "Non-default services in listener_priority order: { key, target_group_arn, path_patterns } (auth-apigw origin_header mode mirrors them behind its header check)."
  value = [
    for k in sort([for k, s in local.routed_services : format("%05d %s", s.listener_priority, k)]) : {
      key              = split(" ", k)[1]
      target_group_arn = aws_lb_target_group.this[split(" ", k)[1]].arn
      path_patterns    = local.routed_services[split(" ", k)[1]].path_patterns
    }
  ]
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

output "target_group_arn_suffixes" {
  description = "Target group ARN suffix (targetgroup/<name>/<id>, the TargetGroup dimension of its CloudWatch metrics) per service key."
  value       = { for k, tg in aws_lb_target_group.this : k => tg.arn_suffix }
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
  description = "IAM role name the API code runs as, shared by every service; attach teammates' policies here."
  value       = aws_iam_role.task.name
}

output "execution_role_arn" {
  description = "ECS task execution role ARN."
  value       = aws_iam_role.execution.arn
}

output "alb_arn_suffix" {
  description = "ALB ARN suffix (app/<name>/<id>), the LoadBalancer dimension of its CloudWatch metrics."
  value       = aws_lb.this.arn_suffix
}

