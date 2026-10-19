# Credentials/profile are NOT configured here. Select them per shell, e.g.
#   export AWS_PROFILE=ticketmastery
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "TicketMastery"
      Owner       = "elroy"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
