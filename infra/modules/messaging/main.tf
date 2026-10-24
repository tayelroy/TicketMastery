# UC4 e-ticket pipeline (Shi Hui):
#   API --publish--> SNS order-events --> SQS ticket-queue --> ticket-fn Lambda (later PR)
#                                              |
#                                              +-- after max_receive_count failures --> SQS ticket-dlq
# The API publishes OrderConfirmed (UC4) and, later, ConcertCancelled (UC5) to the same topic.

################################################################################
# SNS topic
################################################################################

# Not KMS-encrypted: SNS only passes messages through; they are stored encrypted in SQS (SSE-SQS below).
resource "aws_sns_topic" "order_events" {
  name = "${var.name}-order-events"

  tags = merge(var.tags, {
    Name = "${var.name}-order-events"
  })
}

################################################################################
# SQS ticket-queue + DLQ
################################################################################

resource "aws_sqs_queue" "ticket_dlq" {
  name                      = "${var.name}-ticket-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum: time to inspect and re-drive failures
  sqs_managed_sse_enabled   = true

  tags = merge(var.tags, {
    Name = "${var.name}-ticket-dlq"
  })
}

resource "aws_sqs_queue" "ticket" {
  name                       = "${var.name}-ticket-queue"
  visibility_timeout_seconds = 6 * var.ticket_fn_timeout_seconds
  message_retention_seconds  = 345600 # 4 days (default)
  receive_wait_time_seconds  = 20     # long polling: fewer empty receives
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ticket_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.tags, {
    Name = "${var.name}-ticket-queue"
  })
}

# Only ticket-queue may use the DLQ.
resource "aws_sqs_queue_redrive_allow_policy" "ticket_dlq" {
  queue_url = aws_sqs_queue.ticket_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.ticket.arn]
  })
}

################################################################################
# SNS -> SQS subscription
################################################################################

# Lets the order-events topic (and nothing else) put messages on ticket-queue.
data "aws_iam_policy_document" "ticket_queue" {
  statement {
    sid       = "AllowOrderEventsTopic"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ticket.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.order_events.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "ticket" {
  queue_url = aws_sqs_queue.ticket.id
  policy    = data.aws_iam_policy_document.ticket_queue.json
}

# Raw delivery: the SQS message body is exactly the JSON the API published (no SNS envelope), and the
# eventType message attribute is kept, so ticket-fn can tell OrderConfirmed from ConcertCancelled.
resource "aws_sns_topic_subscription" "ticket_queue" {
  topic_arn            = aws_sns_topic.order_events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.ticket.arn
  raw_message_delivery = true

  depends_on = [aws_sqs_queue_policy.ticket]
}

################################################################################
# API permission
################################################################################

data "aws_iam_policy_document" "api_publish" {
  statement {
    sid       = "PublishOrderEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.order_events.arn]
  }
}

resource "aws_iam_role_policy" "api_publish" {
  name   = "messaging-order-events-publish"
  role   = var.api_task_role_name
  policy = data.aws_iam_policy_document.api_publish.json
}

################################################################################
# Alarm
################################################################################

# Anything in the DLQ is an e-ticket that was never sent. No alarm action yet: it shows as "In alarm" in the
# CloudWatch console. Add an SNS email action here if the team wants notifications.
resource "aws_cloudwatch_metric_alarm" "ticket_dlq_not_empty" {
  alarm_name          = "${var.name}-ticket-dlq-not-empty"
  alarm_description   = "E-tickets failed ${var.max_receive_count} times and are waiting in ${aws_sqs_queue.ticket_dlq.name}."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ticket_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  tags = var.tags
}
