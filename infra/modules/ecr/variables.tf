variable "repository_name" {
  description = "ECR repository name."
  type        = string
  default     = "ticketmastery-api"
}

variable "force_delete" {
  description = "Allow `terraform destroy` to delete the repository even if it still contains images."
  type        = bool
  default     = true
}

variable "keep_image_count" {
  description = "Number of most recent images to retain; older ones are expired."
  type        = number
  default     = 10
}
