# Execution role for queue-manager Lambda (least privilege)

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "queue_manager" {
  name               = "queue-manager-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# CloudWatch logs + create/delete the ENIs the Lambda needs inside the VPC
resource "aws_iam_role_policy_attachment" "queue_manager_vpc" {
  role       = aws_iam_role.queue_manager.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# SQS: only join-queue. DynamoDB: only live-queue + its indexes.
data "aws_iam_policy_document" "queue_manager" {
  statement {
    sid = "ReadJoinQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.join.arn]
  }

  statement {
    sid = "LiveQueueTable"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query", # for admit-batch (Part B) on position-index
    ]
    resources = [
      aws_dynamodb_table.live_queue.arn,
      "${aws_dynamodb_table.live_queue.arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "queue_manager" {
  name   = "queue-manager-access"
  role   = aws_iam_role.queue_manager.id
  policy = data.aws_iam_policy_document.queue_manager.json
}

# The API (ECS Fargate task role) sends joins and reads queue status. Nothing else.
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "SendJoins"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.join.arn]
  }

  statement {
    sid       = "ReadQueueStatus"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.live_queue.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "waiting-room-api-access"
  role   = var.task_role_name
  policy = data.aws_iam_policy_document.api.json
}
