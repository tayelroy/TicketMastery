output "endpoint" {
  description = "Connection endpoint in host:port form."
  value       = aws_db_instance.this.endpoint
}

output "address" {
  description = "DB hostname (no port)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "DB port."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Initial database name."
  value       = aws_db_instance.this.db_name
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed Secrets Manager secret holding JSON keys `username` and `password`."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "instance_id" {
  description = "DB instance identifier."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "DB instance ARN."
  value       = aws_db_instance.this.arn
}

output "availability_zone" {
  description = "AZ of the DB instance (the primary, when Multi-AZ)."
  value       = aws_db_instance.this.availability_zone
}
