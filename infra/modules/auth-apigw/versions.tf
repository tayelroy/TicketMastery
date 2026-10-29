terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Only used when alb_integration = "origin_header" (the shared-secret header).
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
