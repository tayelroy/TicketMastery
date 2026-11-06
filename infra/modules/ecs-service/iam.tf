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

# Every distinct DB secret a service uses (main.tf local.db_secret_arns): the RDS-managed master secret and any
# per-service one (services[*].db_secret_arn, e.g. the reporting service's reporting_ro login). Each is encrypted with
# the AWS-managed aws/secretsmanager key, so no explicit kms:Decrypt grant is needed. The role is shared, but each
# task definition names only its own secret, so a container only ever receives its own service's credentials.
data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.db_secret_arns
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

# ECS Exec: the SSM agent in the task opens its session channel with the task role.
data "aws_iam_policy_document" "ecs_exec" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"] # these actions don't support resource-level permissions
  }
}

resource "aws_iam_role_policy" "ecs_exec" {
  count  = var.enable_execute_command ? 1 : 0
  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.ecs_exec.json
}

# No application permissions here (only ECS Exec above). Teammates grant the API access to their
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
