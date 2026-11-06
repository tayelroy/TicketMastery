# Per service: its own scalable target (min/max) and two target-tracking policies on its own metrics, so load on
# one use case (e.g. browsing) scales only that service.
resource "aws_appautoscaling_target" "this" {
  for_each = var.enable_autoscaling ? local.services : {}

  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = each.value.autoscaling_min
  max_capacity       = each.value.autoscaling_max
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = aws_appautoscaling_target.this

  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "requests" {
  for_each = aws_appautoscaling_target.this

  name               = "${var.name}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling_requests_per_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.this[each.key].arn_suffix}"
    }
  }
}
