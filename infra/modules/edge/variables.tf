variable "name" {
  description = "Name prefix for TicketMastery resources"
  type        = string
}

variable "tags" {
  description = "Additional tags for edge resources"
  type        = map(string)

  default = {
    Owner = "cody"
  }
}

variable "api_gateway_domain" {
  description = "API Gateway hostname, without https:// or a path"
  type        = string
  default     = ""
}
