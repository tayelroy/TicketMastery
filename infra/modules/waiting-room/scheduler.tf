# EventBridge Scheduler -> queue-manager every minute: the admit step (step 7 on the diagram)

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    # Only schedules in this account may use the role (confused-deputy guard).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "admit_scheduler" {
  name               = "queue-manager-admit-scheduler-role"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "admit_scheduler" {
  statement {
    sid       = "InvokeQueueManager"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.queue_manager.arn]
  }
}

resource "aws_iam_role_policy" "admit_scheduler" {
  name   = "invoke-queue-manager"
  role   = aws_iam_role.admit_scheduler.id
  policy = data.aws_iam_policy_document.admit_scheduler.json
}

resource "aws_scheduler_schedule" "admit" {
  name        = "queue-manager-admit"
  description = "Admits the next ${var.admit_batch_size} waiting fans per concert into live-queue"
  state       = var.admit_schedule_enabled ? "ENABLED" : "DISABLED"

  schedule_expression = "rate(1 minute)"
  start_date          = var.admit_schedule_start_date
  end_date            = var.admit_schedule_end_date

  flexible_time_window {
    mode = "OFF" # fans expect to move every minute, not "sometime within a window"
  }

  target {
    arn      = aws_lambda_function.queue_manager.arn
    role_arn = aws_iam_role.admit_scheduler.arn
    input    = jsonencode({ action = "admit" })

    # The next run is a minute away and does the same work, so retrying a missed one only adds overlap.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# Scheduler invokes Lambda asynchronously; Lambda would otherwise retry a failed admit run twice on its own.
# Doesn't affect the SQS trigger, which invokes synchronously.
resource "aws_lambda_function_event_invoke_config" "queue_manager" {
  function_name          = aws_lambda_function.queue_manager.function_name
  maximum_retry_attempts = 0
}
