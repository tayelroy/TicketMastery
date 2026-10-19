resource "aws_db_subnet_group" "this" {
  name        = "${var.name}-db-subnets"
  description = "Private subnets for ${var.name} PostgreSQL"
  subnet_ids  = var.private_subnet_ids

  tags = {
    Name = "${var.name}-db-subnets"
  }
}

# Suffix keeps final snapshot names unique across destroy/recreate cycles.
resource "random_id" "final_snapshot_suffix" {
  byte_length = 4
}

resource "aws_db_instance" "this" {
  identifier = "${var.name}-postgres"

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.username
  port     = var.port

  # RDS generates the master password and stores it in Secrets Manager as
  # JSON {"username": ..., "password": ...}. No plaintext password in code or state.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.rds_sg_id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  # Default parameter group for the family; PostgreSQL 15+ defaults rds.force_ssl = 1.

  backup_retention_period = var.backup_retention_period
  copy_tags_to_snapshot   = true
  deletion_protection     = var.deletion_protection

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-postgres-final-${random_id.final_snapshot_suffix.hex}"

  auto_minor_version_upgrade   = true
  performance_insights_enabled = false

  tags = {
    Name = "${var.name}-postgres"
  }
}
