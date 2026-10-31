# ticket-fn Lambda (lambdas/ticket-fn): ticket-queue -> e-ticket PDF in S3 + email via SES.
# Runs outside the VPC: it only calls S3, SES and Cognito, so it needs no NAT or endpoints.

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  ticket_fn_name = "${var.name}-ticket-fn"
}

################################################################################
# E-ticket bucket (private)
################################################################################

resource "aws_s3_bucket" "tickets" {
  bucket_prefix = "${var.name}-tickets-"
  force_destroy = true # dev: terraform destroy must work with tickets inside

  tags = merge(var.tags, {
    Name = "${var.name}-tickets"
  })
}

resource "aws_s3_bucket_public_access_block" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

################################################################################
# Function
################################################################################

# Zips lambdas/ticket-fn/src on every plan/apply (tests live outside src/).
data "archive_file" "ticket_fn" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambdas/ticket-fn/src"
  output_path = "${path.module}/../../../lambdas/ticket-fn/dist/ticket_fn.zip" # gitignored
  excludes    = ["__pycache__"]
}

resource "aws_cloudwatch_log_group" "ticket_fn" {
  name              = "/aws/lambda/${local.ticket_fn_name}"
  retention_in_days = 14

  tags = var.tags
}

resource "aws_lambda_function" "ticket_fn" {
  function_name    = local.ticket_fn_name
  description      = "UC4: OrderConfirmed/ConcertCancelled from ticket-queue -> e-ticket PDF in S3 + SES email"
  role             = aws_iam_role.ticket_fn.arn
  runtime          = "python3.13"
  handler          = "lambda_function.lambda_handler"
  filename         = data.archive_file.ticket_fn.output_path
  source_code_hash = data.archive_file.ticket_fn.output_base64sha256
  timeout          = var.ticket_fn_timeout_seconds # ticket-queue visibility timeout is 6x this
  memory_size      = 256

  environment {
    variables = {
      TICKET_BUCKET            = aws_s3_bucket.tickets.bucket
      SENDER_EMAIL             = var.ses_sender_email
      USER_POOL_ID             = var.cognito_user_pool_id
      FALLBACK_RECIPIENT_EMAIL = var.fallback_recipient_email
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.ticket_fn,
    aws_iam_role_policy.ticket_fn,
  ]

  tags = var.tags
}

# The SQS trigger. Each message succeeds or fails on its own (ReportBatchItemFailures); failures retry and,
# after max_receive_count tries, move to ticket-dlq.
resource "aws_lambda_event_source_mapping" "ticket_queue" {
  event_source_arn        = aws_sqs_queue.ticket.arn
  function_name           = aws_lambda_function.ticket_fn.arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]

  # SES sandbox sends about 1 email/second; two concurrent invocations is plenty.
  scaling_config {
    maximum_concurrency = 2
  }

  tags = var.tags
}

################################################################################
# IAM
################################################################################

data "aws_iam_policy_document" "ticket_fn_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ticket_fn" {
  name               = "${local.ticket_fn_name}-role"
  assume_role_policy = data.aws_iam_policy_document.ticket_fn_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "ticket_fn" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ticket_fn.arn}:*"]
  }

  statement {
    sid       = "ReadTicketQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.ticket.arn]
  }

  # GetObject backs the "already sent?" HeadObject check; ListBucket makes a missing marker a 404 instead of a 403.
  statement {
    sid       = "TicketObjects"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.tickets.arn}/*"]
  }

  statement {
    sid       = "TicketBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tickets.arn]
  }

  statement {
    sid       = "LookUpFanEmail"
    actions   = ["cognito-idp:AdminGetUser"]
    resources = [var.cognito_user_pool_arn]
  }

  # In the SES sandbox recipients are identities too, so the resource is every identity in this account and
  # region; the condition still limits the From address to the configured sender.
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendRawEmail"]
    resources = ["arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_sender_email]
    }
  }
}

resource "aws_iam_role_policy" "ticket_fn" {
  name   = "ticket-fn"
  role   = aws_iam_role.ticket_fn.id
  policy = data.aws_iam_policy_document.ticket_fn.json
}
