# UC4 e-tickets (Shi Hui): ticket-queue --> ticket-fn Lambda --> PDF in the e-ticket bucket + email through SES.
# The Lambda runs outside the VPC: it only calls S3, SES and Cognito, and the VPC has no NAT.

locals {
  ticket_fn_name = "${var.name}-ticket-fn"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

################################################################################
# E-ticket bucket (private)
################################################################################

resource "aws_s3_bucket" "tickets" {
  bucket_prefix = "${var.name}-etickets-"
  force_destroy = var.force_destroy

  tags = merge(var.tags, {
    Name = "${var.name}-etickets"
  })
}

resource "aws_s3_bucket_ownership_controls" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tickets" {
  bucket = aws_s3_bucket.tickets.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Fans download through pre-signed HTTPS links (UC2); plain HTTP is refused for everyone.
data "aws_iam_policy_document" "tickets_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.tickets.arn, "${aws_s3_bucket.tickets.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "tickets" {
  bucket = aws_s3_bucket.tickets.id
  policy = data.aws_iam_policy_document.tickets_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.tickets]
}

################################################################################
# SES sender identity
################################################################################

# Creating it makes SES email a verification link to the address; nothing is sent until it is clicked. While the
# account is in the SES sandbox, every recipient must be verified the same way (console, see the module README).
resource "aws_sesv2_email_identity" "sender" {
  email_identity = var.ses_from_address

  tags = var.tags
}

################################################################################
# Lambda
################################################################################

# Zips the committed esbuild bundle (lambdas/ticket-fn/bundle/index.js, built by `npm run build`), so plan never
# runs npm. The zip itself is gitignored.
data "archive_file" "ticket_fn" {
  type        = "zip"
  source_file = "${path.module}/../../../lambdas/ticket-fn/bundle/index.js"
  output_path = "${path.module}/../../../lambdas/ticket-fn/dist/ticket_fn.zip"
}

resource "aws_cloudwatch_log_group" "ticket_fn" {
  name              = "/aws/lambda/${local.ticket_fn_name}"
  retention_in_days = var.log_retention_days

  tags = var.tags
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ticket_fn" {
  name               = local.ticket_fn_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "ticket_fn" {
  # The log group is created above, so the function never needs logs:CreateLogGroup.
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ticket_fn.arn}:*"]
  }

  statement {
    sid       = "ConsumeTicketQueue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.ticket.arn]
  }

  # PDFs and sent markers (tickets/<orderId>.pdf, tickets/<orderId>.sent).
  statement {
    sid       = "TicketObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.tickets.arn}/tickets/*"]
  }

  # Without it, HeadObject on a missing marker answers 403 instead of 404 and every first delivery would fail.
  statement {
    sid       = "ListTicketBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tickets.arn]
  }

  # identity/* rather than the sender's ARN alone: in the SES sandbox the recipient's identity is authorised too.
  # The condition still limits the function to sending as the configured sender.
  statement {
    sid       = "SendAsTicketSender"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"] # SESv2 SendEmail with raw content is authorised as SendRawEmail
    resources = ["arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*"]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_from_address]
    }
  }

  statement {
    sid       = "LookUpFanEmail"
    actions   = ["cognito-idp:AdminGetUser"]
    resources = [var.cognito_user_pool_arn]
  }
}

resource "aws_iam_role_policy" "ticket_fn" {
  name   = "ticket-fn"
  role   = aws_iam_role.ticket_fn.id
  policy = data.aws_iam_policy_document.ticket_fn.json
}

resource "aws_lambda_function" "ticket_fn" {
  function_name    = local.ticket_fn_name
  description      = "UC4: renders the e-ticket PDF for OrderConfirmed and emails it through SES"
  role             = aws_iam_role.ticket_fn.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.ticket_fn.output_path
  source_code_hash = data.archive_file.ticket_fn.output_base64sha256
  timeout          = var.ticket_fn_timeout_seconds
  memory_size      = var.ticket_fn_memory_mb

  environment {
    variables = {
      TICKET_PDF_BUCKET    = aws_s3_bucket.tickets.id
      SES_FROM_ADDRESS     = var.ses_from_address
      COGNITO_USER_POOL_ID = var.cognito_user_pool_id
    }
  }

  tags = merge(var.tags, {
    Name = local.ticket_fn_name
  })

  depends_on = [
    aws_cloudwatch_log_group.ticket_fn,
    aws_iam_role_policy.ticket_fn,
  ]
}

# Up to 10 records per invocation, at most 2 invocations at once: SES in the sandbox sends 1 email per second, so
# more concurrency would only produce throttling retries. Failed records alone go back to the queue.
resource "aws_lambda_event_source_mapping" "ticket_queue" {
  event_source_arn        = aws_sqs_queue.ticket.arn
  function_name           = aws_lambda_function.ticket_fn.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = 2
  }

  depends_on = [aws_iam_role_policy.ticket_fn]
}

################################################################################
# API permission: UC2 download link
################################################################################

# The API checks the PDF exists (HeadObject, which needs s3:ListBucket for a 404 rather than 403) and pre-signs a
# GetObject link with the task role's credentials.
data "aws_iam_policy_document" "api_ticket_read" {
  statement {
    sid       = "ReadTicketPdfs"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.tickets.arn}/tickets/*"]
  }

  statement {
    sid       = "ListTicketBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.tickets.arn]
  }
}

resource "aws_iam_role_policy" "api_ticket_read" {
  name   = "messaging-ticket-pdf-read"
  role   = var.api_task_role_name
  policy = data.aws_iam_policy_document.api_ticket_read.json
}
