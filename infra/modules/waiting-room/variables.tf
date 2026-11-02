# Settings you might want to tweak without touching the rest of the code

variable "vpc_id" {
  description = "VPC the queue-manager Lambda runs in (from the network module)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the Lambda. Their route tables carry the DynamoDB gateway endpoint."
  type        = list(string)
}

variable "task_role_name" {
  description = "ECS task role the API runs as (ecs-service output); gets SendMessage on join-queue and GetItem on live-queue"
  type        = string
}

variable "waiting_ttl_seconds" {
  description = "How long a WAITING user's row lives before DynamoDB TTL deletes it (21600 = 6 hours)"
  type        = number
  default     = 21600
}

variable "lambda_timeout" {
  description = "Max seconds one queue-manager run may take. SQS visibility timeout is set to 6x this."
  type        = number
  default     = 30
}

variable "join_trigger_enabled" {
  description = "Turn the SQS -> Lambda trigger on/off (set false when not testing to avoid idle polling)"
  type        = bool
  default     = true
}

variable "admit_batch_size" {
  description = "Fans the admit step lets in per concert per run (one run a minute)"
  type        = number
  default     = 500
}

variable "admission_window_seconds" {
  description = "How long an admitted fan may start checkout (hold seats) before the admission expires"
  type        = number
  default     = 900
}

variable "admit_schedule_enabled" {
  description = "Run the admit step every minute (EventBridge Scheduler). False pauses admission without deleting the schedule."
  type        = bool
  default     = true
}

variable "admit_schedule_start_date" {
  description = "Optional RFC 3339 time (e.g. 2026-11-09T19:55:00+08:00) before which the admit schedule doesn't run. Null = start now."
  type        = string
  default     = null
}

variable "admit_schedule_end_date" {
  description = "Optional RFC 3339 time after which the admit schedule stops. Null = no end. Set both dates to limit it to a sale window."
  type        = string
  default     = null
}
