variable "name" {
  description = "Name prefix for every resource (e.g. ticketmastery-dev)."
  type        = string
}

variable "api_task_role_name" {
  description = "Name of the API's ECS task role (root output task_role_name); gets sns:Publish on order-events and read access to the e-ticket PDFs."
  type        = string
}

variable "ses_from_address" {
  description = "Sender of the e-ticket emails. Terraform creates it as an SES email identity; the address owner must click the verification link before anything is sent."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.ses_from_address))
    error_message = "ses_from_address must be a single email address."
  }
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool of the fans (auth-apigw output user_pool_id); ticket-fn looks up each buyer's email there."
  type        = string
}

variable "cognito_user_pool_arn" {
  description = "ARN of the same user pool (auth-apigw output user_pool_arn); scopes ticket-fn's cognito-idp:AdminGetUser."
  type        = string
}

variable "ticket_fn_timeout_seconds" {
  description = "Timeout of the ticket-fn Lambda. The ticket-queue visibility timeout is 6x this, as AWS recommends for Lambda triggers, so change both together through this variable."
  type        = number
  default     = 60
}

variable "ticket_fn_memory_mb" {
  description = "Memory of the ticket-fn Lambda (CPU scales with it); 256 MB renders a one-page PDF in well under a second."
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "Retention of the ticket-fn log group."
  type        = number
  default     = 14
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the e-ticket bucket even if it still holds PDFs (dev)."
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified when the ticket-dlq alarm changes to ALARM or back to OK (e.g. monitoring's alerts_topic_arn)."
  type        = list(string)
  default     = []
}

variable "max_receive_count" {
  description = "Failed deliveries before a ticket-queue message moves to the DLQ."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Additional tags for messaging resources."
  type        = map(string)

  default = {
    Owner = "shihui"
  }
}
