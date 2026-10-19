output "alb_sg_id" {
  description = "Security group ID of the public ALB."
  value       = aws_security_group.alb.id
}

output "ecs_sg_id" {
  description = "Security group ID of the ECS Fargate tasks."
  value       = aws_security_group.ecs.id
}

output "rds_sg_id" {
  description = "Security group ID of the RDS instance."
  value       = aws_security_group.rds.id
}
