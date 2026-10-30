variable "name" {
  description = "Name prefix for every resource (e.g. ticketmastery-dev)."
  type        = string
}

variable "api_task_role_name" {
  description = "Name of the API's ECS task role (root output task_role_name); gets sns:Publish on order-events."
  type        = string
}

variable "ticket_fn_timeout_seconds" {
  description = "Planned timeout of the ticket-fn Lambda. The ticket-queue visibility timeout is 6x this, as AWS recommends for Lambda triggers."
  type        = number
  default     = 60
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
