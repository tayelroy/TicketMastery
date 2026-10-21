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

# Additional AWS provider - N. Virginia
# Required for CloudFront WAF
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "TicketMastery"
      Owner       = "cody"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}