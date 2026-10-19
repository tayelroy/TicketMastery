# Local state for now. State is gitignored (infra/.gitignore); whoever applies
# holds it, so only one person should apply dev until the remote backend exists.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}

# Shared remote state (switch once the account owner creates the bucket/table):
# replace the block above with the one below, then run
#   terraform init -migrate-state
#
# terraform {
#   backend "s3" {
#     bucket         = "ticketmastery-tfstate-<account-id>"
#     key            = "envs/dev/terraform.tfstate"
#     region         = "ap-southeast-1"
#     dynamodb_table = "ticketmastery-tf-locks" # partition key: LockID (String)
#     encrypt        = true
#   }
# }
