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

################################################################################
# Waiting room
################################################################################

output "join_queue_url" {
  description = "SQS FIFO join-queue URL; pass to the API as JOIN_QUEUE_URL."
  value       = module.waiting_room.join_queue_url
}

output "join_queue_arn" {
  description = "SQS FIFO join-queue ARN (grant the API sqs:SendMessage on it)."
  value       = module.waiting_room.join_queue_arn
}

output "live_queue_table_name" {
  description = "DynamoDB live-queue table name; the API reads queue positions from it."
  value       = module.waiting_room.live_queue_table_name
}

################################################################################
# Auth + API Gateway
################################################################################

output "cognito_user_pool_id" {
  description = "Cognito user pool ID; GitHub repo variable COGNITO_USER_POOL_ID (frontend build)."
  value       = module.auth_apigw.user_pool_id
}

output "cognito_user_pool_client_id" {
  description = "Cognito browser app client ID; GitHub repo variable COGNITO_CLIENT_ID (frontend build)."
  value       = module.auth_apigw.user_pool_client_id
}

output "cognito_issuer_url" {
  description = "JWT issuer of the user pool."
  value       = module.auth_apigw.issuer_url
}

output "api_endpoint" {
  description = "API Gateway base URL; test with curl $(terraform output -raw api_endpoint)/health."
  value       = module.auth_apigw.api_endpoint
}

output "api_access_log_group_name" {
  description = "CloudWatch log group with API Gateway access logs."
  value       = module.auth_apigw.access_log_group_name
}

################################################################################
# Messaging (e-ticket pipeline)
################################################################################

output "order_events_topic_arn" {
  description = "SNS order-events topic ARN; the API publishes OrderConfirmed (UC4) and ConcertCancelled (UC5) here."
  value       = module.messaging.order_events_topic_arn
}

output "ticket_queue_arn" {
  description = "SQS ticket-queue ARN; event source for the ticket-fn Lambda."
  value       = module.messaging.ticket_queue_arn
}

output "ticket_dlq_url" {
  description = "SQS ticket-dlq URL; e-tickets that failed 5 times wait here for inspection."
  value       = module.messaging.ticket_dlq_url
}

output "ticket_bucket_name" {
  description = "Private S3 bucket with e-ticket PDFs (tickets/<orderId>.pdf)."
  value       = module.messaging.ticket_bucket_name
}

output "ticket_fn_name" {
  description = "ticket-fn Lambda; logs: aws logs tail /aws/lambda/<name> --follow."
  value       = module.messaging.ticket_fn_name
}
