variable "name" {
  description = "Name prefix for every resource (e.g. ticketmastery-dev)."
  type        = string
}

variable "api_task_role_name" {
  description = "Name of the API's ECS task role (root output task_role_name); gets sns:Publish on order-events."
  type        = string
}

variable "ticket_fn_timeout_seconds" {
  description = "Timeout of the ticket-fn Lambda. The ticket-queue visibility timeout is 6x this, as AWS recommends for Lambda triggers."
  type        = number
  default     = 60
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool ID (auth module); ticket-fn looks up the fan's email there."
  type        = string
}

variable "cognito_user_pool_arn" {
  description = "Cognito user pool ARN; ticket-fn gets cognito-idp:AdminGetUser on it."
  type        = string
}

variable "ses_sender_email" {
  description = "Verified SES identity the e-ticket emails are sent from. Empty = ticket-fn cannot send (messages retry, then go to the DLQ)."
  type        = string
  default     = ""
}

variable "fallback_recipient_email" {
  description = "Testing only: verified SES address that gets the email when the fan has no Cognito user (AUTH_MODE=dev-header ids like fan-1). Empty = no fallback."
  type        = string
  default     = ""
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
