# queue-manager Lambda + SQS trigger

# Zips lambdas/queue-manager/src/ automatically on every plan/apply
data "archive_file" "queue_manager" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambdas/queue-manager/src"
  output_path = "${path.module}/../../../lambdas/queue-manager/dist/queue_manager.zip" # gitignored
}

resource "aws_cloudwatch_log_group" "queue_manager" {
  name              = "/aws/lambda/queue-manager"
  retention_in_days = 14
}

resource "aws_lambda_function" "queue_manager" {
  function_name    = "queue-manager"
  role             = aws_iam_role.queue_manager.arn
  runtime          = "python3.13"
  handler          = "lambda_function.lambda_handler"
  filename         = data.archive_file.queue_manager.output_path
  source_code_hash = data.archive_file.queue_manager.output_base64sha256
  timeout          = var.lambda_timeout
  memory_size      = 128

  environment {
    variables = {
      TABLE_NAME          = aws_dynamodb_table.live_queue.name
      WAITING_TTL_SECONDS = tostring(var.waiting_ttl_seconds)
    }
  }

  # Runs in the private subnets. DynamoDB traffic leaves via the gateway endpoint
  # on their route tables (no NAT). The SQS trigger and CloudWatch logs are handled
  # by the Lambda service itself, so they need no endpoint.
  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.queue_manager.id]
  }

  depends_on = [
    aws_cloudwatch_log_group.queue_manager,
    aws_iam_role_policy_attachment.queue_manager_vpc,
  ]
}

# Outbound only. With no NAT, the only HTTPS destinations reachable from the
# private subnets are the gateway endpoints (DynamoDB, S3).
resource "aws_security_group" "queue_manager" {
  name        = "queue-manager-lambda-sg"
  description = "queue-manager Lambda: no inbound, HTTPS out"
  vpc_id      = var.vpc_id

  egress {
    description = "HTTPS to DynamoDB via gateway endpoint"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The "Add trigger -> SQS" step from the console
resource "aws_lambda_event_source_mapping" "join_queue" {
  event_source_arn        = aws_sqs_queue.join.arn
  function_name           = aws_lambda_function.queue_manager.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"] # the checkbox
  enabled                 = var.join_trigger_enabled

  depends_on = [aws_iam_role_policy.queue_manager]
}
