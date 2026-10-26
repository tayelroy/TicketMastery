# HTTP API in front of the ALB. Protected routes need a Cognito ACCESS token (JWT authorizer); the API verifies the
# token again (src/auth). Two ways to reach the ALB, chosen by var.alb_integration:
#   vpc_link       (option B): private integration through a VPC link to an internal ALB. No secret, no ALB cert.
#   origin_header  (option A): public HTTPS to the ALB's own domain + a secret header the ALB listener requires.

locals {
  use_vpc_link      = var.alb_integration == "vpc_link"
  use_origin_header = var.alb_integration == "origin_header"

  # Public or protected depending on var.waiting_room_public (protected by default: guests can't queue).
  waiting_room_routes = [
    "ANY /api/waiting-room",
    "ANY /api/waiting-room/{proxy+}",
  ]

  # Unlisted paths get API Gateway's own 404 (deny by default). A new /api/<prefix> must be added here.
  public_routes = toset(concat([
    "GET /health",
    "GET /api/concerts",
    "GET /api/concerts/{proxy+}",
  ], var.waiting_room_public ? local.waiting_room_routes : [], var.extra_public_routes))

  protected_routes = toset(concat([
    "ANY /api/me",
    "ANY /api/me/{proxy+}",
    "ANY /api/checkout",
    "ANY /api/checkout/{proxy+}",
    "ANY /api/organiser",
    "ANY /api/organiser/{proxy+}",
  ], var.waiting_room_public ? [] : local.waiting_room_routes, var.extra_protected_routes))
}

################################################################################
# Option B: VPC link (API Gateway's private door into the VPC)
################################################################################

resource "aws_security_group" "vpc_link" {
  count = local.use_vpc_link ? 1 : 0

  name        = "${var.name}-apigw-vpclink-sg"
  description = "API Gateway VPC link ENIs"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-apigw-vpclink-sg" })
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_alb" {
  count = local.use_vpc_link ? 1 : 0

  security_group_id            = aws_security_group.vpc_link[0].id
  description                  = "To the ALB listener only"
  ip_protocol                  = "tcp"
  from_port                    = var.alb_listener_port
  to_port                      = var.alb_listener_port
  referenced_security_group_id = var.alb_sg_id
}

# A separate rule resource on the base stack's ALB SG, so the security module itself is not edited.
resource "aws_vpc_security_group_ingress_rule" "alb_from_vpc_link" {
  count = local.use_vpc_link ? 1 : 0

  security_group_id            = var.alb_sg_id
  description                  = "ALB listener from the API Gateway VPC link"
  ip_protocol                  = "tcp"
  from_port                    = var.alb_listener_port
  to_port                      = var.alb_listener_port
  referenced_security_group_id = aws_security_group.vpc_link[0].id
}

resource "aws_apigatewayv2_vpc_link" "this" {
  count = local.use_vpc_link ? 1 : 0

  name               = "${var.name}-vpclink"
  subnet_ids         = var.private_subnet_ids # both AZs
  security_group_ids = [aws_security_group.vpc_link[0].id]
  tags               = var.tags
}

################################################################################
# Option A: shared-secret header checked by ALB listener rules
################################################################################

resource "random_password" "origin_verify" {
  count = local.use_origin_header ? 1 : 0

  length  = 48
  special = false # header-safe characters only
}

resource "aws_lb_listener_rule" "from_api_gateway" {
  count = local.use_origin_header ? 1 : 0

  listener_arn = var.alb_listener_arn # HTTPS :443
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = var.api_target_group_arn
  }

  condition {
    http_header {
      http_header_name = "x-origin-verify"
      values           = [random_password.origin_verify[0].result]
    }
  }
}

# Catches everything rule 10 didn't, so the listener's default forward is never reached. ALB health checks go
# straight to the targets and are not affected.
resource "aws_lb_listener_rule" "deny_everything_else" {
  count = local.use_origin_header ? 1 : 0

  listener_arn = var.alb_listener_arn
  priority     = 20

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}

################################################################################
# HTTP API, integration, JWT authorizer
################################################################################

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.name}-http-api"
  protocol_type = "HTTP"
  description   = "TicketMastery API: Cognito JWT authorizer in front of the ticketmastery-api ALB"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  payload_format_version = "1.0"

  # vpc_link: the LISTENER ARN (not the ALB ARN). origin_header: the ALB's own HTTPS name (matches its certificate).
  integration_uri = local.use_vpc_link ? var.alb_listener_arn : "https://${var.alb_origin_domain}"
  connection_type = local.use_vpc_link ? "VPC_LINK" : "INTERNET"
  connection_id   = one(aws_apigatewayv2_vpc_link.this[*].id)

  # origin_header only: keep the request path, and overwrite (never append) the secret so a caller can't inject one.
  request_parameters = local.use_origin_header ? {
    "overwrite:path"                   = "$request.path"
    "overwrite:header.x-origin-verify" = one(random_password.origin_verify[*].result)
  } : null

  lifecycle {
    precondition {
      condition     = var.alb_listener_arn != null && (local.use_vpc_link || (var.alb_origin_domain != "" && var.api_target_group_arn != ""))
      error_message = "alb_listener_arn is null (origin_header needs certificate_arn so the HTTPS listener exists), or origin_header is missing alb_origin_domain / api_target_group_arn."
    }
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.http.id
  name             = "cognito-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://${aws_cognito_user_pool.this.endpoint}"
    audience = [aws_cognito_user_pool_client.spa.id] # matched against `client_id` in access tokens
  }
}

################################################################################
# Routes
################################################################################

resource "aws_apigatewayv2_route" "public" {
  for_each = local.public_routes

  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_apigatewayv2_route" "protected" {
  for_each = local.protected_routes

  api_id             = aws_apigatewayv2_api.http.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.alb.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

################################################################################
# Stage: auto-deploy, throttling, JSON access logs
################################################################################

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}-http-api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default" # a named stage would prefix its name to the path the ALB/API sees
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.throttling_rate_limit
    throttling_burst_limit = var.throttling_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId   = "$context.requestId"
      ip          = "$context.identity.sourceIp"
      routeKey    = "$context.routeKey"
      status      = "$context.status"
      latencyMs   = "$context.responseLatency"
      integStatus = "$context.integrationStatus"
      authError   = "$context.authorizer.error"
      sub         = "$context.authorizer.claims.sub"
    })
  }

  tags = var.tags
}
