variable "name" {
  description = "Name prefix for every resource (e.g. ticketmastery-dev)."
  type        = string
}

variable "alert_email" {
  description = "Address that receives alarm notifications (SNS email subscription, confirm the first email) and AWS Budgets alerts."
  type        = string
}

variable "tags" {
  description = "Additional tags for monitoring resources."
  type        = map(string)
  default     = {}
}

################################################################################
# Monitored resources (all plain values from other modules' outputs)
################################################################################

variable "alb_arn_suffix" {
  description = "ALB ARN suffix (app/<name>/<id>), the LoadBalancer dimension (ecs-service output alb_arn_suffix)."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name (ecs-service output cluster_name)."
  type        = string
}

variable "ecs_services" {
  description = "The API's ECS services, keyed by a static service key used in alarm names and dashboard labels (from ecs-service output services): ECS service name, target group ARN suffix (targetgroup/<name>/<id>, the TargetGroup dimension) and autoscaling maximum (threshold of its scaling-ceiling alarm)."
  type = map(object({
    service_name             = string
    target_group_arn_suffix  = string
    autoscaling_max_capacity = number
  }))
}

variable "autoscaling_enabled" {
  description = "Whether ECS service autoscaling is on (root enable_autoscaling). The scaling-ceiling alarms only exist when it is: with a fixed task count a service is always \"at max\"."
  type        = bool
  default     = false
}

variable "rds_instance_id" {
  description = "RDS DB instance identifier (rds output instance_id)."
  type        = string
}

variable "rds_max_connections" {
  description = "RDS PostgreSQL max_connections. Default LEAST(DBInstanceClassMemory/9531392, 5000) is at most 112 on db.t4g.micro (1 GiB), and lower in practice because RDS reserves part of the memory; 80 is a conservative estimate. Check with SHOW max_connections; and set the real value."
  type        = number
  default     = 80
}

variable "rds_free_storage_threshold_bytes" {
  description = "Alarm when RDS FreeStorageSpace drops below this many bytes."
  type        = number
  default     = 2147483648 # 2 GiB of the 20 GiB gp3 volume
}

variable "http_api_id" {
  description = "API Gateway HTTP API ID, the ApiId dimension (auth-apigw output api_id)."
  type        = string
}

variable "ticket_queue_name" {
  description = "SQS ticket-queue name (messaging output ticket_queue_name)."
  type        = string
}

variable "ticket_dlq_name" {
  description = "SQS ticket-dlq name (messaging output ticket_dlq_name). Dashboard only: its alarm lives in the messaging module."
  type        = string
}

variable "join_dlq_name" {
  description = "SQS join-queue DLQ name (waiting-room output join_dlq_name)."
  type        = string
}

variable "lambda_function_names" {
  description = "Lambda functions to alarm on Errors and Throttles, keyed by a static label used in alarm names (e.g. { queue-manager = \"queue-manager\", ticket-fn = module.messaging.ticket_fn_function_name })."
  type        = map(string)
}

variable "api_log_group_name" {
  description = "CloudWatch log group of the API container logs (ecs-service output log_group_name); holds the pino request logs the checkout-failure metric filters read."
  type        = string
}

################################################################################
# Thresholds
################################################################################

variable "alb_p95_latency_seconds" {
  description = "ALB TargetResponseTime p95 threshold (seconds); NFR-1 target is p95 < 300 ms."
  type        = number
  default     = 0.3
}

variable "error_rate_percent" {
  description = "5xx rate threshold (percent of requests over 5 minutes) for the ALB targets and API Gateway."
  type        = number
  default     = 1
}

variable "ecs_utilization_percent" {
  description = "ECS service average CPU and memory utilisation threshold (percent)."
  type        = number
  default     = 80
}

variable "rds_cpu_percent" {
  description = "RDS CPUUtilization threshold (percent)."
  type        = number
  default     = 75
}

variable "apigw_p95_latency_ms" {
  description = "API Gateway Latency p95 threshold (ms). Above the ALB's 300 ms because it adds the JWT authorizer and VPC link hop."
  type        = number
  default     = 500
}

variable "ticket_queue_max_age_seconds" {
  description = "Alarm when the oldest ticket-queue message is older than this (seconds)."
  type        = number
  default     = 60
}

variable "eticket_latency_p95_ms" {
  description = "NFR-7: alarm when the p95 of TicketMastery/ETicketDeliveryLatency over 5 minutes exceeds this (ms)."
  type        = number
  default     = 60000
}

variable "waiting_room_size_threshold" {
  description = "Alarm when TicketMastery/WaitingRoomSize exceeds this many fans."
  type        = number
  default     = 20000
}

variable "checkout_failure_percent" {
  description = "Alarm when failed payments exceed this percentage of payment attempts over 5 minutes."
  type        = number
  default     = 20
}

variable "checkout_failure_min_attempts" {
  description = "Minimum payment attempts in the 5-minute window before the failure rate can alarm, so one declined card on a quiet day doesn't page anyone."
  type        = number
  default     = 5
}

################################################################################
# Budget
################################################################################

variable "budget_limit_usd" {
  description = "Monthly cost budget (USD); a forecast above it also notifies."
  type        = number
  default     = 80
}

variable "budget_alert_thresholds_usd" {
  description = "Actual-spend amounts (USD) that each send a Budgets email. AWS allows at most 5 notifications per budget, and one is the forecast alert."
  type        = list(number)
  default     = [20, 40, 60, 80]

  validation {
    condition     = length(var.budget_alert_thresholds_usd) <= 4
    error_message = "At most 4 actual-spend thresholds: a budget has at most 5 notifications and one is used by the forecast alert."
  }
}
