# join-queue: FIFO line of join requests, with a DLQ for messages that fail 3 times

resource "aws_sqs_queue" "join_dlq" {
  name                      = "join-queue-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600 # 14 days, time to inspect failures
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "join" {
  name                        = "join-queue.fifo"
  fifo_queue                  = true
  content_based_deduplication = false                  # API sends MessageDeduplicationId = userId#eventId
  visibility_timeout_seconds  = 6 * var.lambda_timeout # 180s with a 30s Lambda
  message_retention_seconds   = 345600                 # 4 days (default)
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.join_dlq.arn
    maxReceiveCount     = 3
  })
}
