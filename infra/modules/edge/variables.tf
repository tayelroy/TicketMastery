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

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete the frontend bucket even if it still contains objects (including old versions)."
  type        = bool
  default     = true
}
