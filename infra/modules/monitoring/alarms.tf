# Every alarm notifies the alerts topic when it fires and again when it recovers. The README's alarm table explains
# each threshold. "notBreaching" for missing data wherever no data simply means no traffic.

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]

  alb_dimensions = { LoadBalancer = var.alb_arn_suffix }
  # Per ECS service (one per use case): its target group and its ECS service.
  tg_dimensions  = { for k, s in var.ecs_services : k => { LoadBalancer = var.alb_arn_suffix, TargetGroup = s.target_group_arn_suffix } }
  ecs_dimensions = { for k, s in var.ecs_services : k => { ClusterName = var.ecs_cluster_name, ServiceName = s.service_name } }
  rds_dimensions = { DBInstanceIdentifier = var.rds_instance_id }

  rds_connections_threshold = floor(var.rds_max_connections * 0.8)

  lambda_alarms = {
    for pair in setproduct(keys(var.lambda_function_names), ["Errors", "Throttles"]) :
    "${pair[0]}-${lower(pair[1])}" => {
      function_name = var.lambda_function_names[pair[0]]
      metric        = pair[1]
    }
  }
}

################################################################################
# ALB (API latency, errors, target health)
################################################################################

resource "aws_cloudwatch_metric_alarm" "alb_latency_p95" {
  alarm_name          = "${var.name}-alb-p95-latency"
  alarm_description   = "API p95 response time (ALB TargetResponseTime) above ${var.alb_p95_latency_seconds * 1000} ms for 3 consecutive minutes (NFR-1). Check ECS CPU and RDS load on the dashboard."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.alb_dimensions
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alb_p95_latency_seconds
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

# Rate rather than count: a fixed count would be noise at demo traffic and miss real trouble at on-sale traffic.
resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${var.name}-alb-target-5xx-rate"
  alarm_description   = "API (ALB target) 5xx responses above ${var.error_rate_percent}% of requests over 5 minutes. Check the API logs for 'unhandled error'."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "100 * FILL(errors, 0) / requests"
    label       = "Target 5xx rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = local.alb_dimensions
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = local.alb_dimensions
      stat        = "Sum"
      period      = 300
    }
  }

  tags = var.tags
}

# Per service only what says WHICH use case is in trouble: no healthy task (that part of the API is down) and, with
# autoscaling, at max capacity (that service hit its ceiling). A failing-but-not-all-down task shows up in the
# ALB/API Gateway 5xx alarms, and CPU/memory are watched across services below, so the alarm count stays small.
# Latency and 5xx above stay ALB-wide: NFR-1 and the error budget are for the API as a whole.

# The ALB reports HealthyHostCount every minute whether or not there is traffic, so missing data is itself a fault.
resource "aws_cloudwatch_metric_alarm" "alb_no_healthy_hosts" {
  for_each = var.ecs_services

  alarm_name          = "${var.name}-${each.key}-alb-no-healthy-hosts"
  alarm_description   = "No healthy ${each.key} task behind the ALB for 2 minutes: that part of the API is down. Check the ECS service events of ${each.value.service_name} (failed deployments, stopped tasks)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = local.tg_dimensions[each.key]
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

################################################################################
# ECS services (replace the proposal's EC2/ASG rows)
################################################################################

locals {
  # Metric-math ids must start with a lower-case letter and contain no hyphens.
  ecs_metric_ids = { for i, k in local.service_keys : k => "s${i}" }
}

# One alarm each for CPU and memory: the highest average across all services. Autoscaling already reacts to CPU per
# service and ecs-at-max-capacity names a service that can't scale further; the dashboard shows one line per service
# to see which one is hot.
resource "aws_cloudwatch_metric_alarm" "ecs_max_utilization" {
  for_each = { cpu = "CPUUtilization", memory = "MemoryUtilization" }

  alarm_name          = "${var.name}-ecs-max-${each.key}-high"
  alarm_description   = "The busiest ECS service's average ${each.key} is above ${var.ecs_utilization_percent}% for 5 minutes. Find it on the dashboard (one line per service), then raise its autoscaling max or task size${each.key == "memory" ? "; tasks risk being OOM-killed" : ""}."
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.ecs_utilization_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "busiest"
    expression  = "MAX([${join(", ", values(local.ecs_metric_ids))}])"
    label       = "Busiest service ${each.key} %"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = local.ecs_metric_ids

    content {
      id = metric_query.value

      metric {
        namespace   = "AWS/ECS"
        metric_name = each.value
        dimensions  = local.ecs_dimensions[metric_query.key]
        stat        = "Average"
        period      = 60
      }
    }
  }

  tags = var.tags
}

# LiveTaskCount is a free AWS/ECS service metric (no Container Insights needed, since Oct 2026). Only meaningful
# with autoscaling: with a fixed desired count the service sits "at max" all the time.
resource "aws_cloudwatch_metric_alarm" "ecs_at_max_capacity" {
  for_each = var.autoscaling_enabled ? var.ecs_services : {}

  alarm_name          = "${var.name}-${each.key}-ecs-at-max-capacity"
  alarm_description   = "${each.value.service_name} has run at its autoscaling maximum (${each.value.autoscaling_max_capacity} tasks) for 5 minutes: the scaling ceiling is reached. Decide whether to raise its autoscaling_max."
  namespace           = "AWS/ECS"
  metric_name         = "LiveTaskCount"
  dimensions          = local.ecs_dimensions[each.key]
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.autoscaling_max_capacity
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

################################################################################
# RDS
################################################################################

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.name}-rds-cpu-high"
  alarm_description   = "RDS CPU above ${var.rds_cpu_percent}% for 5 minutes. db.t4g.micro is burstable: check CPUCreditBalance and slow queries."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = local.rds_dimensions
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.rds_cpu_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name          = "${var.name}-rds-connections-high"
  alarm_description   = "RDS connections above ${local.rds_connections_threshold} (80% of max_connections ${var.rds_max_connections}) for 5 minutes. Each API task holds up to DB_POOL_MAX (10)."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = local.rds_dimensions
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.rds_connections_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage_low" {
  alarm_name          = "${var.name}-rds-free-storage-low"
  alarm_description   = "RDS free storage below ${var.rds_free_storage_threshold_bytes / 1073741824} GiB. Raise db_allocated_storage before writes fail."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = local.rds_dimensions
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = var.rds_free_storage_threshold_bytes
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

################################################################################
# API Gateway HTTP API (what fans actually see, including VPC link and ALB errors)
################################################################################

resource "aws_cloudwatch_metric_alarm" "apigw_5xx_rate" {
  alarm_name          = "${var.name}-apigw-5xx-rate"
  alarm_description   = "API Gateway 5xx responses above ${var.error_rate_percent}% of requests over 5 minutes. Unlike the ALB alarm this also catches VPC link and no-healthy-target errors."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.error_rate_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "100 * FILL(errors, 0) / requests"
    label       = "API Gateway 5xx rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"

    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "5xx"
      dimensions  = { ApiId = var.http_api_id }
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "requests"

    metric {
      namespace   = "AWS/ApiGateway"
      metric_name = "Count"
      dimensions  = { ApiId = var.http_api_id }
      stat        = "Sum"
      period      = 300
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "apigw_latency_p95" {
  alarm_name          = "${var.name}-apigw-p95-latency"
  alarm_description   = "API Gateway p95 latency above ${var.apigw_p95_latency_ms} ms for 3 consecutive minutes. Compare with the ALB p95 to tell gateway overhead from slow API code."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = { ApiId = var.http_api_id }
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.apigw_p95_latency_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

################################################################################
# Queues and Lambdas (e-ticket backlog, waiting room)
################################################################################

resource "aws_cloudwatch_metric_alarm" "ticket_queue_age" {
  alarm_name          = "${var.name}-ticket-queue-oldest-message"
  alarm_description   = "Oldest ticket-queue message is older than ${var.ticket_queue_max_age_seconds} s: e-tickets are not going out within seconds. Check the ticket-fn Lambda errors and logs."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = var.ticket_queue_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.ticket_queue_max_age_seconds
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

# The ticket-dlq alarm lives in the messaging module (alarm_actions = this topic); this is the waiting room's DLQ.
resource "aws_cloudwatch_metric_alarm" "join_dlq_not_empty" {
  alarm_name          = "${var.name}-join-dlq-not-empty"
  alarm_description   = "Waiting-room join requests failed queue-manager repeatedly and wait in ${var.join_dlq_name}: those fans never got a position. Check the queue-manager logs."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.join_dlq_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "lambda" {
  for_each = local.lambda_alarms

  alarm_name          = "${var.name}-lambda-${each.key}"
  alarm_description   = "Lambda ${each.value.function_name} reported ${each.value.metric} in the last 5 minutes. Check its CloudWatch logs (/aws/lambda/${each.value.function_name})."
  namespace           = "AWS/Lambda"
  metric_name         = each.value.metric
  dimensions          = { FunctionName = each.value.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

# queue-manager writes this metric as CloudWatch Embedded Metric Format on stdout (it runs in the VPC without NAT,
# so it can't call PutMetricData); no data outside the sale window is normal.
resource "aws_cloudwatch_metric_alarm" "waiting_room_size" {
  alarm_name          = "${var.name}-waiting-room-size"
  alarm_description   = "More than ${var.waiting_room_size_threshold} fans waiting. Admins decide whether to raise the admit batch size or the API autoscaling maximum."
  namespace           = "TicketMastery"
  metric_name         = "WaitingRoomSize"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.waiting_room_size_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}

################################################################################
# Checkout failures (from the log metric filters in main.tf)
################################################################################

resource "aws_cloudwatch_metric_alarm" "checkout_failure_rate" {
  alarm_name          = "${var.name}-checkout-failure-rate"
  alarm_description   = "More than ${var.checkout_failure_percent}% of payment attempts failed over 5 minutes (at least ${var.checkout_failure_min_attempts} attempts): the payment gateway is likely down."
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.checkout_failure_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "rate"
    expression  = "IF(attempts >= ${var.checkout_failure_min_attempts}, 100 * FILL(failures, 0) / attempts, 0)"
    label       = "Failed payments (%)"
    return_data = true
  }

  metric_query {
    id = "failures"

    metric {
      namespace   = "TicketMastery"
      metric_name = aws_cloudwatch_log_metric_filter.checkout_failures.metric_transformation[0].name
      stat        = "Sum"
      period      = 300
    }
  }

  metric_query {
    id = "attempts"

    metric {
      namespace   = "TicketMastery"
      metric_name = aws_cloudwatch_log_metric_filter.checkout_attempts.metric_transformation[0].name
      stat        = "Sum"
      period      = 300
    }
  }

  tags = var.tags
}

# NFR-7: 95% of e-tickets emailed within 60 s of payment. ticket-fn writes one datapoint per sent email (EMF), so
# no data means no sales, which is fine. The oldest-message alarm catches a stalled pipeline; this one catches a
# slow but moving one (e.g. SES throttling in the sandbox).
resource "aws_cloudwatch_metric_alarm" "eticket_delivery_latency" {
  alarm_name          = "${var.name}-eticket-delivery-latency"
  alarm_description   = "p95 e-ticket delivery (payment to SES accepted) above ${var.eticket_latency_p95_ms / 1000} s over 5 minutes (NFR-7). Check ticket-fn errors, SES sending limits and ticket-queue age."
  namespace           = "TicketMastery"
  metric_name         = "ETicketDeliveryLatency"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.eticket_latency_p95_ms
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  tags = var.tags
}
