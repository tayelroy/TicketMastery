output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC IPv4 CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "azs" {
  description = "Availability zones used, in subnet order."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB, NAT, and the ECS tasks in implementation mode), one per AZ."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (RDS, VPC Lambdas, and the ECS tasks in the HA design), one per AZ."
  value       = aws_subnet.private[*].id
}

output "private_route_table_ids" {
  description = "Private route table IDs, one per AZ."
  value       = aws_route_table.private[*].id
}
