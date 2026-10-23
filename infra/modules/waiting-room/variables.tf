# Settings you might want to tweak without touching the rest of the code

variable "vpc_id" {
  description = "VPC the queue-manager Lambda runs in (from the network module)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the Lambda. Their route tables carry the DynamoDB gateway endpoint."
  type        = list(string)
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
