# Values teammates need (e.g. the Fargate API's env vars and IAM policy)

output "join_queue_url" {
  description = "API sends join requests here (POST /queue/join)"
  value       = aws_sqs_queue.join.url
}

output "join_queue_arn" {
  description = "For the Fargate task role: sqs:SendMessage on this ARN"
  value       = aws_sqs_queue.join.arn
}

output "join_dlq_url" {
  value = aws_sqs_queue.join_dlq.url
}

output "live_queue_table_name" {
  description = "API reads positions from here (GET /queue/status)"
  value       = aws_dynamodb_table.live_queue.name
}

output "live_queue_table_arn" {
  description = "For the Fargate task role: dynamodb:GetItem on this ARN"
  value       = aws_dynamodb_table.live_queue.arn
}

output "lambda_sg_id" {
  description = "queue-manager Lambda SG; add to rds_extra_ingress_sg_ids when it needs RDS"
  value       = aws_security_group.queue_manager.id
}

output "queue_manager_function_name" {
  value = aws_lambda_function.queue_manager.function_name
}
