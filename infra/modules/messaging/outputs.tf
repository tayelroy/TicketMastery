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

output "ticket_queue_name" {
  description = "SQS ticket-queue name (the QueueName dimension of its CloudWatch metrics)."
  value       = aws_sqs_queue.ticket.name
}

output "ticket_dlq_name" {
  description = "SQS ticket-dlq name (the QueueName dimension of its CloudWatch metrics)."
  value       = aws_sqs_queue.ticket_dlq.name
}

output "ticket_pdf_bucket_name" {
  description = "Private e-ticket bucket (PDFs at tickets/<orderId>.pdf). The API gets it as TICKET_PDF_BUCKET."
  value       = aws_s3_bucket.tickets.id
}

output "ticket_pdf_bucket_arn" {
  description = "ARN of the e-ticket bucket."
  value       = aws_s3_bucket.tickets.arn
}

output "ticket_fn_function_name" {
  description = "ticket-fn Lambda function name (the FunctionName dimension of its CloudWatch metrics)."
  value       = aws_lambda_function.ticket_fn.function_name
}

output "ticket_fn_log_group_name" {
  description = "ticket-fn log group; query the \"e-ticket sent\" lines (deliveryLatencyMs) with Logs Insights."
  value       = aws_cloudwatch_log_group.ticket_fn.name
}

output "ses_sender_identity_arn" {
  description = "SES email identity of the e-ticket sender."
  value       = aws_sesv2_email_identity.sender.arn
}
