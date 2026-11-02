# One dashboard: alarm status on top, then one graph per alarm signal, in the same order as alarms.tf.
# Horizontal annotations draw each alarm threshold on its graph.

data "aws_region" "current" {}

locals {
  region = data.aws_region.current.name

  alarms = concat(
    [
      aws_cloudwatch_metric_alarm.alb_latency_p95,
      aws_cloudwatch_metric_alarm.alb_5xx_rate,
      aws_cloudwatch_metric_alarm.alb_unhealthy_hosts,
      aws_cloudwatch_metric_alarm.alb_no_healthy_hosts,
      aws_cloudwatch_metric_alarm.ecs_cpu_high,
      aws_cloudwatch_metric_alarm.ecs_memory_high,
    ],
    aws_cloudwatch_metric_alarm.ecs_at_max_capacity,
    [
      aws_cloudwatch_metric_alarm.rds_cpu_high,
      aws_cloudwatch_metric_alarm.rds_connections_high,
      aws_cloudwatch_metric_alarm.rds_free_storage_low,
      aws_cloudwatch_metric_alarm.apigw_5xx_rate,
      aws_cloudwatch_metric_alarm.apigw_latency_p95,
      aws_cloudwatch_metric_alarm.ticket_queue_age,
      aws_cloudwatch_metric_alarm.join_dlq_not_empty,
    ],
    [for k in sort(keys(aws_cloudwatch_metric_alarm.lambda)) : aws_cloudwatch_metric_alarm.lambda[k]],
    [
      aws_cloudwatch_metric_alarm.waiting_room_size,
      aws_cloudwatch_metric_alarm.checkout_failure_rate,
    ],
  )
  alarm_arns = local.alarms[*].arn

  # Each entry becomes an 8x6 time-series widget, three per row.
  graphs = [
    {
      title = "API p95 / p99 response time (ALB)"
      metrics = [
        ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, { stat = "p95", label = "p95" }],
        ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, { stat = "p99", label = "p99" }],
      ]
      period      = 60
      annotations = [{ label = "p95 alarm", value = var.alb_p95_latency_seconds }]
      left_label  = "Seconds"
    },
    {
      title = "API requests and target 5xx rate (ALB)"
      metrics = [
        [{ expression = "100 * FILL(errors, 0) / requests", label = "Target 5xx rate (%)", id = "rate" }],
        ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum", id = "errors", visible = false }],
        ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix, { stat = "Sum", id = "requests", label = "Requests", yAxis = "right" }],
      ]
      period      = 300
      annotations = [{ label = "5xx alarm (%)", value = var.error_rate_percent }]
      left_label  = "Percent"
    },
    {
      title = "API target health (ALB)"
      metrics = [
        ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix, { stat = "Minimum", label = "Healthy" }],
        ["AWS/ApplicationELB", "UnHealthyHostCount", "TargetGroup", var.target_group_arn_suffix, "LoadBalancer", var.alb_arn_suffix, { stat = "Maximum", label = "Unhealthy" }],
      ]
      period      = 60
      annotations = [{ label = "healthy alarm (< 1)", value = 1 }]
      left_label  = "Tasks"
    },
    {
      title = "ECS service CPU and memory"
      metrics = [
        ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_name, { stat = "Average", label = "CPU" }],
        ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_name, { stat = "Average", label = "Memory" }],
      ]
      period      = 60
      annotations = [{ label = "alarm", value = var.ecs_utilization_percent }]
      left_label  = "Percent"
    },
    {
      title = "ECS running tasks vs autoscaling max"
      metrics = [
        ["AWS/ECS", "LiveTaskCount", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_name, { stat = "Maximum", label = "Live tasks" }],
      ]
      period      = 60
      annotations = [{ label = "autoscaling max", value = var.autoscaling_max_capacity }]
      left_label  = "Tasks"
    },
    {
      title = "RDS CPU"
      metrics = [
        ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_id, { stat = "Average", label = "CPU" }],
        ["AWS/RDS", "CPUCreditBalance", "DBInstanceIdentifier", var.rds_instance_id, { stat = "Minimum", label = "CPU credits", yAxis = "right" }],
      ]
      period      = 60
      annotations = [{ label = "CPU alarm", value = var.rds_cpu_percent }]
      left_label  = "Percent"
    },
    {
      title = "RDS connections"
      metrics = [
        ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.rds_instance_id, { stat = "Maximum", label = "Connections" }],
      ]
      period = 60
      annotations = [
        { label = "alarm (80%)", value = local.rds_connections_threshold },
        { label = "max_connections", value = var.rds_max_connections },
      ]
      left_label = "Connections"
    },
    {
      title = "RDS free storage"
      metrics = [
        ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.rds_instance_id, { stat = "Minimum", label = "Free storage" }],
      ]
      period      = 300
      annotations = [{ label = "alarm", value = var.rds_free_storage_threshold_bytes }]
      left_label  = "Bytes"
    },
    {
      title = "API Gateway requests and 5xx rate"
      metrics = [
        [{ expression = "100 * FILL(errors, 0) / requests", label = "5xx rate (%)", id = "rate" }],
        ["AWS/ApiGateway", "5xx", "ApiId", var.http_api_id, { stat = "Sum", id = "errors", visible = false }],
        ["AWS/ApiGateway", "Count", "ApiId", var.http_api_id, { stat = "Sum", id = "requests", label = "Requests", yAxis = "right" }],
      ]
      period      = 300
      annotations = [{ label = "5xx alarm (%)", value = var.error_rate_percent }]
      left_label  = "Percent"
    },
    {
      title = "API Gateway p95 latency"
      metrics = [
        ["AWS/ApiGateway", "Latency", "ApiId", var.http_api_id, { stat = "p95", label = "Latency p95" }],
        ["AWS/ApiGateway", "IntegrationLatency", "ApiId", var.http_api_id, { stat = "p95", label = "Integration latency p95" }],
      ]
      period      = 60
      annotations = [{ label = "latency alarm", value = var.apigw_p95_latency_ms }]
      left_label  = "Milliseconds"
    },
    {
      title = "E-ticket backlog (ticket-queue)"
      metrics = [
        ["AWS/SQS", "ApproximateAgeOfOldestMessage", "QueueName", var.ticket_queue_name, { stat = "Maximum", label = "Oldest message (s)" }],
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.ticket_queue_name, { stat = "Maximum", label = "Messages waiting", yAxis = "right" }],
      ]
      period      = 60
      annotations = [{ label = "age alarm (s)", value = var.ticket_queue_max_age_seconds }]
      left_label  = "Seconds"
    },
    {
      # ticket-fn writes this per sent e-ticket email (EMF, no dimensions). Evidence for "e-tickets arrive within
      # seconds"; no alarm, the oldest-message alarm already catches a stalled pipeline.
      title = "E-ticket delivery latency (ticket-fn)"
      metrics = [
        ["TicketMastery", "ETicketDeliveryLatency", { stat = "p95", label = "p95" }],
        ["TicketMastery", "ETicketDeliveryLatency", { stat = "Maximum", label = "max" }],
      ]
      period      = 300
      annotations = []
      left_label  = "Milliseconds"
    },
    {
      title = "Dead-letter queues"
      metrics = [
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.ticket_dlq_name, { stat = "Maximum", label = "ticket-dlq" }],
        ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", var.join_dlq_name, { stat = "Maximum", label = "join-queue DLQ" }],
      ]
      period      = 300
      annotations = [{ label = "alarm (> 0)", value = 0 }]
      left_label  = "Messages"
    },
    {
      title = "Lambda errors and throttles"
      # concat, not flatten: flatten would also unpack each metric's own array.
      metrics = concat([
        for label in sort(keys(var.lambda_function_names)) : [
          ["AWS/Lambda", "Errors", "FunctionName", var.lambda_function_names[label], { stat = "Sum", label = "${label} errors" }],
          ["AWS/Lambda", "Throttles", "FunctionName", var.lambda_function_names[label], { stat = "Sum", label = "${label} throttles" }],
          ["AWS/Lambda", "Invocations", "FunctionName", var.lambda_function_names[label], { stat = "Sum", label = "${label} invocations", yAxis = "right" }],
        ]
      ]...)
      period      = 300
      annotations = [{ label = "alarm (> 0)", value = 0 }]
      left_label  = "Count"
    },
    {
      title = "Waiting room size"
      metrics = [
        ["TicketMastery", "WaitingRoomSize", { stat = "Maximum", label = "Fans waiting" }],
      ]
      period      = 60
      annotations = [{ label = "alarm", value = var.waiting_room_size_threshold }]
      left_label  = "Fans"
    },
    {
      title = "Checkout payment failures"
      metrics = [
        [{ expression = "100 * FILL(failures, 0) / attempts", label = "Failed payments (%)", id = "rate" }],
        ["TicketMastery", "CheckoutPaymentFailures", { stat = "Sum", id = "failures", label = "Failed", yAxis = "right" }],
        ["TicketMastery", "CheckoutPaymentAttempts", { stat = "Sum", id = "attempts", label = "Attempts", yAxis = "right" }],
      ]
      period      = 300
      annotations = [{ label = "alarm (%)", value = var.checkout_failure_percent }]
      left_label  = "Percent"
    },
  ]

  header_widgets = [
    {
      type   = "text"
      x      = 0
      y      = 0
      width  = 24
      height = 2
      properties = {
        markdown = "# ${var.name}\nAlarms notify the SNS topic `${aws_sns_topic.alerts.name}` (email). Thresholds and reasons: `infra/modules/monitoring/README.md`."
      }
    },
    {
      type   = "alarm"
      x      = 0
      y      = 2
      width  = 24
      height = 6
      properties = {
        title  = "Alarm status"
        alarms = local.alarm_arns
      }
    },
  ]

  graph_widgets = [
    for i, g in local.graphs : {
      type   = "metric"
      x      = (i % 3) * 8
      y      = 8 + floor(i / 3) * 6
      width  = 8
      height = 6
      properties = {
        title   = g.title
        region  = local.region
        view    = "timeSeries"
        stacked = false
        period  = g.period
        metrics = g.metrics
        annotations = {
          horizontal = g.annotations
        }
        yAxis = {
          left = { label = g.left_label, min = 0, showUnits = false }
        }
      }
    }
  ]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({ widgets = concat(local.header_widgets, local.graph_widgets) })
}
