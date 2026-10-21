variable "name" {
  description = "Name prefix for TicketMastery resources"
  type        = string
}

variable "github_repository" {
  description = "GitHub repository allowed to deploy"
  type        = string
  default     = "tayelroy/TicketMastery"
}

variable "frontend_bucket_arn" {
  description = "ARN of the frontend S3 bucket"
  type        = string
}

variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution"
  type        = string
}
