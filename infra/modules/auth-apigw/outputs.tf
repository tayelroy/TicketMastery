output "user_pool_id" {
  description = "Cognito user pool ID (API env COGNITO_USER_POOL_ID; frontend VITE_COGNITO_USER_POOL_ID)."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_client_id" {
  description = "Browser app client ID (API env COGNITO_CLIENT_ID; frontend VITE_COGNITO_CLIENT_ID)."
  value       = aws_cognito_user_pool_client.spa.id
}

output "issuer_url" {
  description = "JWT issuer for the user pool."
  value       = "https://${aws_cognito_user_pool.this.endpoint}"
}

output "api_id" {
  description = "HTTP API ID."
  value       = aws_apigatewayv2_api.http.id
}

output "api_endpoint" {
  description = "HTTP API base URL (https://<id>.execute-api.<region>.amazonaws.com)."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "api_domain" {
  description = "HTTP API hostname without https://, for the CloudFront /api/* origin (edge module api_gateway_domain)."
  value       = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
}

output "vpc_link_sg_id" {
  description = "VPC link security group (vpc_link mode), or null."
  value       = one(aws_security_group.vpc_link[*].id)
}

output "access_log_group_name" {
  description = "CloudWatch log group for API Gateway access logs."
  value       = aws_cloudwatch_log_group.access.name
}

# Deliberately no output for the origin_header secret: it must never appear in logs, CI output or screenshots.
