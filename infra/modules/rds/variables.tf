variable "name" {
  description = "Name prefix, e.g. ticketmastery-dev. Instance identifier becomes <name>-postgres."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs (at least 2 AZs) for the DB subnet group."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "Security group attached to the DB instance."
  type        = string
}

variable "engine_version" {
  description = "PostgreSQL major (e.g. \"16\") or full version. A major-only value lets AWS pick and auto-upgrade the minor."
  type        = string
  default     = "16"
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Allocated gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Initial database name."
  type        = string
  default     = "ticketmastery"
}

variable "username" {
  description = "Master username. The password is generated and stored by RDS in Secrets Manager."
  type        = string
  default     = "tmadmin"
}

variable "port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "multi_az" {
  description = "Deploy a synchronous standby in a second AZ (doubles instance cost)."
  type        = bool
  default     = false
}

variable "availability_zone" {
  description = "AZ for a single-AZ instance (must be one of the DB subnet group's AZs). Must be null when multi_az = true. null lets AWS choose. Changing it on an existing instance replaces the instance."
  type        = string
  default     = null
}

variable "backup_retention_period" {
  description = "Days to retain automated backups (0 disables backups)."
  type        = number
  default     = 1
}

variable "deletion_protection" {
  description = "Block deletion of the DB instance. Must be false before `terraform destroy`."
  type        = bool
  default     = false
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Set false to keep a snapshot of the data."
  type        = bool
  default     = true
}
