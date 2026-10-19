data "aws_region" "current" {}

resource "aws_cloudwatch_log_group" "api" {
  name              = var.log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
}

################################################################################
# Task definition
################################################################################

locals {
  environment = merge(
    {
      NODE_ENV = "production"
      PORT     = tostring(var.container_port)
      DB_HOST  = var.db_host
      DB_PORT  = tostring(var.db_port)
      DB_NAME  = var.db_name
      DB_SSL   = "true"
      # dev-header is a development shortcut; switch to cognito once Andrew's
      # Cognito + API Gateway authorizer is live.
      AUTH_MODE = var.auth_mode
      # The API refuses NODE_ENV=production + dev-header unless this is true;
      # derived so it turns off automatically when auth_mode = "cognito".
      ALLOW_DEV_AUTH = var.auth_mode == "dev-header" ? "true" : "false"
      # Migrations take a pg advisory lock, so concurrent tasks don't race.
      RUN_MIGRATIONS_ON_START = tostring(var.run_migrations_on_start)
    },
    var.extra_environment,
  )

  container_definition = merge(
    {
      name      = var.container_name
      image     = "${var.ecr_repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [for k in sort(keys(local.environment)) : { name = k, value = local.environment[k] }]

      # Resolved by the execution role at task start from the RDS-managed secret JSON.
      secrets = [
        { name = "DB_USER", valueFrom = "${var.db_secret_arn}:username::" },
        { name = "DB_PASSWORD", valueFrom = "${var.db_secret_arn}:password::" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = data.aws_region.current.name
          awslogs-stream-prefix = "api"
        }
      }
    },
    # Only emit healthCheck when enabled; a null key causes perpetual diffs.
    {
      for k, v in {
        healthCheck = {
          command     = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:${var.container_port}${var.health_check_path} || exit 1"]
          interval    = 30
          timeout     = 5
          retries     = 3
          startPeriod = 30
        }
      } : k => v if var.enable_container_health_check
    },
  )
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([local.container_definition])
}

################################################################################
# Service
################################################################################

resource "aws_ecs_service" "api" {
  name             = "${var.name}-api"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.api.arn
  desired_count    = var.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.ecs_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  propagate_tags = "SERVICE"

  # Task definition changes ARE managed by Terraform (no ignore_changes): bump
  # image_tag (or push a new `latest` and force a new deployment) to roll out.

  depends_on = [
    aws_lb_listener.http,
    aws_iam_role_policy_attachment.execution_managed,
    aws_iam_role_policy.execution_secrets,
  ]
}
