# Chain: internet -> alb_sg -> ecs_sg -> rds_sg.
# aws_security_group created by Terraform has NO default egress rule; every
# allowed flow is an explicit *_rule resource below.

################################################################################
# ALB
################################################################################

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb-sg"
  description = "TicketMastery public ALB"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-alb-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.alb_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP from ${each.key}"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.key
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = var.enable_https ? toset(var.alb_ingress_cidrs) : toset([])

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from ${each.key}"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.key
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ecs" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To ECS tasks on container port"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.ecs.id
}

################################################################################
# ECS tasks
################################################################################

resource "aws_security_group" "ecs" {
  name        = "${var.name}-ecs-sg"
  description = "TicketMastery ECS Fargate tasks"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-ecs-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs.id
  description                  = "Container port from ALB only"
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  referenced_security_group_id = aws_security_group.alb.id
}

# Tasks need outbound HTTPS to ECR/Logs/Secrets Manager/SQS/SNS/DynamoDB
# (via NAT or VPC endpoints) and 5432 to RDS.
resource "aws_vpc_security_group_egress_rule" "ecs_all" {
  security_group_id = aws_security_group.ecs.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

################################################################################
# RDS
################################################################################

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds-sg"
  description = "TicketMastery RDS PostgreSQL"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-rds-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_ecs" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.ecs.id
}

# count (not for_each over IDs) so callers can pass SG IDs that are unknown
# until apply, e.g. straight from another module's output.
resource "aws_vpc_security_group_ingress_rule" "rds_extra" {
  count = length(var.rds_extra_ingress_sg_ids)

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from extra SG ${count.index}"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = var.rds_extra_ingress_sg_ids[count.index]
}
