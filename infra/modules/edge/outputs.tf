output "frontend_bucket_name" {
  description = "Name of the S3 bucket for the frontend"
  value       = aws_s3_bucket.frontend.id
}

output "frontend_bucket_arn" {
  description = "ARN of the frontend S3 bucket"
  value       = aws_s3_bucket.frontend.arn
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID for cache invalidations"
  value       = aws_cloudfront_distribution.frontend.id
}

output "cloudfront_domain_name" {
  description = "Default CloudFront domain for the frontend"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "waf_web_acl_arn" {
  description = "ARN of the CloudFront WAF Web ACL"
  value       = aws_wafv2_web_acl.frontend.arn
}

output "cloudfront_distribution_arn" {
  description = "ARN of the frontend CloudFront distribution"
  value       = aws_cloudfront_distribution.frontend.arn
}
