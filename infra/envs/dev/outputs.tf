################################################################################
# Network
################################################################################

output "vpc_id" {
  description = "VPC ID."
  value       = module.network.vpc_id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = module.network.vpc_cidr
}

output "public_subnet_ids" {
  description = "Public subnet IDs (2 AZs)."
  value       = module.network.public_subnet_ids
}

output "private_subnet_ids" {
  description = "Private subnet IDs (2 AZs); use for VPC Lambdas that need RDS."
  value       = module.network.private_subnet_ids
}

output "task_subnet_ids" {
  description = "Subnets the API tasks run in: the AZ a public subnet in implementation mode; private subnets in the HA design."
  value       = module.ecs_service.task_subnet_ids
}

################################################################################
# Security groups
################################################################################

output "alb_sg_id" {
  description = "ALB security group ID."
  value       = module.security.alb_sg_id
}

output "ecs_sg_id" {
  description = "ECS task security group ID."
  value       = module.security.ecs_sg_id
}

output "rds_sg_id" {
  description = "RDS security group ID. To grant a Lambda access, add its SG to rds_extra_ingress_sg_ids."
  value       = module.security.rds_sg_id
}

################################################################################
# ALB / ECS / ECR
################################################################################

output "alb_dns_name" {
  description = "ALB DNS name (API Gateway / CloudFront origin)."
  value       = module.ecs_service.alb_dns_name
}

output "alb_arn" {
  description = "ALB ARN."
  value       = module.ecs_service.alb_arn
}

output "alb_listener_arn" {
  description = "Primary ALB listener ARN: HTTPS when a certificate is configured, otherwise HTTP."
  value       = coalesce(module.ecs_service.https_listener_arn, module.ecs_service.http_listener_arn)
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs_service.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name (for `aws ecs update-service --force-new-deployment`)."
  value       = module.ecs_service.service_name
}

output "ecr_repository_url" {
  description = "ECR repository URL to push ticketmastery-api images to."
  value       = module.ecr.repository_url
}

output "task_role_arn" {
  description = "IAM role ARN the API runs as; attach SQS/SNS/DynamoDB policies to it."
  value       = module.ecs_service.task_role_arn
}

output "task_role_name" {
  description = "IAM role name the API runs as (for aws_iam_role_policy.role)."
  value       = module.ecs_service.task_role_name
}

output "log_group_name" {
  description = "CloudWatch log group for API logs."
  value       = module.ecs_service.log_group_name
}

################################################################################
# RDS
################################################################################

output "db_endpoint" {
  description = "RDS endpoint (host:port)."
  value       = module.rds.endpoint
}

output "db_address" {
  description = "RDS hostname."
  value       = module.rds.address
}

output "db_port" {
  description = "RDS port."
  value       = module.rds.port
}

output "db_name" {
  description = "Database name."
  value       = module.rds.db_name
}

output "db_availability_zone" {
  description = "AZ of the DB instance (AZ a when single-AZ; the current primary when Multi-AZ)."
  value       = module.rds.availability_zone
}

output "db_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master credentials (JSON keys username, password). Grant secretsmanager:GetSecretValue on this ARN; never copy the value into code."
  value       = module.rds.master_user_secret_arn
}

output "frontend_bucket_name" {
  description = "Frontend S3 bucket; GitHub repo variable FRONTEND_BUCKET_NAME."
  value       = module.edge.frontend_bucket_name
}

output "cloudfront_distribution_id" {
  description = "Frontend CloudFront distribution ID; GitHub repo variable CLOUDFRONT_DISTRIBUTION_ID, used to clear the cache after each deploy."
  value       = module.edge.cloudfront_distribution_id
}

output "cloudfront_domain_name" {
  description = "Default CloudFront domain serving the frontend."
  value       = module.edge.cloudfront_domain_name
}

output "github_deploy_role_arn" {
  description = "IAM role GitHub Actions assumes to deploy the frontend; GitHub repo variable AWS_DEPLOY_ROLE_ARN."
  value       = module.github_deploy.github_deploy_role_arn
}
