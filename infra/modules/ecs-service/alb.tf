locals {
  enable_https = var.certificate_arn != ""

  # Path rules go on the listener that forwards: HTTPS when a certificate is set (HTTP then only redirects), else HTTP.
  forwarding_listener_arn = local.enable_https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
}

resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  internal           = var.alb_internal
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  # Internal (option B): only API Gateway's VPC link can reach it. Internet-facing: public subnets.
  subnets = var.alb_internal ? var.private_subnet_ids : var.public_subnet_ids

  drop_invalid_header_fields = true
  enable_deletion_protection = false

  tags = {
    Name = "${var.name}-alb"
  }
}

# One target group per service; each health-checks its own tasks on /health (mounted by every service).
resource "aws_lb_target_group" "this" {
  for_each = local.services

  name        = each.value.tg_name
  target_type = "ip" # required for awsvpc / Fargate
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.health_check_path
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = each.value.tg_name
  }

  lifecycle {
    precondition {
      condition     = length(each.value.tg_name) <= 32
      error_message = "Target group name ${each.value.tg_name} is longer than 32 characters; set a shorter tg_short_name for service ${each.key}."
    }
  }
}

# HTTP :80 forwards to the default service, or redirects to HTTPS when a certificate is set.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = local.enable_https ? "redirect" : "forward"
    target_group_arn = local.enable_https ? null : aws_lb_target_group.this[var.default_service].arn

    dynamic "redirect" {
      for_each = local.enable_https ? [1] : []

      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count = local.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[var.default_service].arn
  }
}

# One rule per non-default service: its paths go to its target group; everything else falls through to the default
# service. In auth-apigw's origin_header mode that module puts header-checked rules (priorities 1-20) in front of these.
resource "aws_lb_listener_rule" "path" {
  for_each = local.routed_services

  listener_arn = local.forwarding_listener_arn
  priority     = each.value.listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }

  condition {
    path_pattern {
      values = each.value.path_patterns
    }
  }

  lifecycle {
    precondition {
      condition     = each.value.listener_priority != null && try(each.value.listener_priority > 20, false) && length(each.value.path_patterns) > 0
      error_message = "Service ${each.key} is not the default_service, so it needs path_patterns and a listener_priority above 20 (1-20 are auth-apigw's origin_header rules)."
    }

    precondition {
      condition     = length(distinct([for s in values(local.routed_services) : s.listener_priority])) == length(local.routed_services)
      error_message = "listener_priority must be unique across services."
    }
  }
}
