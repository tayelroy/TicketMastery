output "order_events_topic_arn" {
  description = "SNS order-events topic. The API gets it as ORDER_EVENTS_TOPIC_ARN; UC5 publishes ConcertCancelled here too."
  value       = aws_sns_topic.order_events.arn
}

output "ticket_queue_arn" {
  description = "SQS ticket-queue ARN; the ticket-fn Lambda's event source."
  value       = aws_sqs_queue.ticket.arn
}

output "ticket_queue_url" {
  description = "SQS ticket-queue URL."
  value       = aws_sqs_queue.ticket.url
}

output "ticket_dlq_arn" {
  description = "SQS ticket-dlq ARN (e-tickets that failed max_receive_count times)."
  value       = aws_sqs_queue.ticket_dlq.arn
}

output "ticket_dlq_url" {
  description = "SQS ticket-dlq URL, for inspecting or re-driving failed messages."
  value       = aws_sqs_queue.ticket_dlq.url
}

output "ticket_bucket_name" {
  description = "Private S3 bucket with the e-ticket PDFs (tickets/<orderId>.pdf) and sent markers."
  value       = aws_s3_bucket.tickets.bucket
}

output "ticket_fn_name" {
  description = "ticket-fn Lambda function name (logs: /aws/lambda/<name>)."
  value       = aws_lambda_function.ticket_fn.function_name
}
