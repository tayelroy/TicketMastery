# Shared remote state in S3. Everyone who applies dev reads and writes the same
# state file. use_lockfile (Terraform >= 1.10) stores the lock next to the state
# in S3, so no DynamoDB lock table is needed.
terraform {
  backend "s3" {
    bucket       = "ticketmastery-tfstate-000246635159"
    key          = "envs/dev/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
    encrypt      = true
  }
}
