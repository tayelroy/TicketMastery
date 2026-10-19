data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: only ECS in this account may assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

################################################################################
# Execution role: used by the ECS agent to pull the image, write logs and
# resolve `secrets` before the container starts.
################################################################################

resource "aws_iam_role" "execution" {
  name               = "${var.name}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The RDS-managed secret is encrypted with the AWS-managed aws/secretsmanager
# key, so no explicit kms:Decrypt grant is needed.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-db-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

################################################################################
# Task role: credentials the application code itself uses (AWS SDK).
################################################################################

resource "aws_iam_role" "task" {
  name               = "${var.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# Intentionally no policies here. Teammates grant the API access to their
# resources from their own modules, e.g. in modules/waiting-room:
#
#   resource "aws_iam_role_policy" "api_sqs" {
#     name   = "waiting-room-sqs"
#     role   = var.task_role_name   # from root output task_role_name
#     policy = data.aws_iam_policy_document.api_sqs.json
#   }
#
# Typical grants: sqs:SendMessage on join-queue, sns:Publish on order-events,
# dynamodb:GetItem/Query on live-queue. Keep them least-privilege per resource ARN.
