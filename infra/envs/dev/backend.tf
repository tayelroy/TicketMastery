# Shared remote state in S3 (native S3 lockfile, no DynamoDB table).
# Requires credentials for account 000246635159, e.g. export AWS_PROFILE=ticketmastery
terraform {
  backend "s3" {
    bucket       = "ticketmastery-tfstate-000246635159"
    key          = "envs/dev/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
    encrypt      = true
  }
}
