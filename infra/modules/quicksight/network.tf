# QuickSight reaches the private RDS instance through a VPC connection: network interfaces in our subnets.
# Chain: QuickSight ENIs (quicksight_sg) -> rds_sg on db_port. No inbound rules on quicksight_sg: security groups
# are stateful, and the extra inbound rule AWS documents applies only to VPC connections made before 27 April 2023.

resource "aws_security_group" "quicksight" {
  name        = "${var.name}-quicksight-sg"
  description = "QuickSight VPC connection to RDS"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-quicksight-sg"
  }
}

resource "aws_vpc_security_group_egress_rule" "quicksight_to_rds" {
  security_group_id            = aws_security_group.quicksight.id
  description                  = "PostgreSQL to RDS"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = var.rds_sg_id
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_quicksight" {
  security_group_id            = var.rds_sg_id
  description                  = "PostgreSQL from QuickSight"
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
  referenced_security_group_id = aws_security_group.quicksight.id
}

################################################################################
# Execution role: QuickSight creates and deletes the connection's ENIs with it
################################################################################

# Trust policy as in the AWS VPC connection guide (no aws:SourceAccount condition: AWS doesn't document that
# QuickSight sets it when assuming this role).
data "aws_iam_policy_document" "quicksight_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["quicksight.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vpc_connection" {
  name               = "${var.name}-quicksight-vpc"
  assume_role_policy = data.aws_iam_policy_document.quicksight_assume.json
}

# The minimum AWS documents for a VPC connection's execution role. EC2 has no resource-level permissions for the
# Describe calls, and the network interfaces don't exist yet when they are created, hence "*".
data "aws_iam_policy_document" "vpc_connection" {
  statement {
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "vpc_connection" {
  name   = "quicksight-vpc-connection-enis"
  role   = aws_iam_role.vpc_connection.id
  policy = data.aws_iam_policy_document.vpc_connection.json
}

resource "aws_quicksight_vpc_connection" "this" {
  vpc_connection_id  = "${var.name}-rds"
  name               = "${var.name} RDS"
  role_arn           = aws_iam_role.vpc_connection.arn
  subnet_ids         = var.subnet_ids
  security_group_ids = [aws_security_group.quicksight.id]

  # The role must carry its policy before QuickSight assumes it, and the account must exist.
  depends_on = [aws_iam_role_policy.vpc_connection, aws_quicksight_account_subscription.this]
}
