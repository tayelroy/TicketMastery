variable "name" {
  description = "Name prefix for TicketMastery resources"
  type        = string
}

variable "github_oidc_subject" {
  description = "OIDC subject prefix of the GitHub repo allowed to deploy. Repos on immutable subjects send repo:<owner>@<owner_id>/<repo>@<repo_id>; check with gh api repos/<owner>/<repo>/actions/oidc/customization/sub."
  type        = string
}

variable "frontend_bucket_arn" {
  description = "ARN of the frontend S3 bucket"
  type        = string
}

variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution"
  type        = string
}
