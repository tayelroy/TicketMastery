data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  # QuickSight names an IAM-registered user after the IAM user name.
  admin_user_name = element(split("/", var.admin_iam_arn), length(split("/", var.admin_iam_arn)) - 1)
  # The aws_quicksight_user reference (when registered here) orders every permission after the registration.
  admin_principal = var.register_admin_user ? aws_quicksight_user.admin[0].arn : "arn:aws:quicksight:${local.region}:${local.account_id}:user/default/${local.admin_user_name}"
}

################################################################################
# Account subscription (billed per user per month from creation; see README)
################################################################################

resource "aws_quicksight_account_subscription" "this" {
  account_name          = var.account_name
  edition               = "ENTERPRISE"
  authentication_method = "IAM_AND_QUICKSIGHT"
  notification_email    = var.notification_email
}

# Termination protection blocks DeleteAccountSubscription, so `terraform destroy` could not unsubscribe.
# Destroying this resource only removes it from state; the subscription's own delete then succeeds.
resource "aws_quicksight_account_settings" "this" {
  termination_protection_enabled = false

  depends_on = [aws_quicksight_account_subscription.this]
}

resource "aws_quicksight_user" "admin" {
  count = var.register_admin_user ? 1 : 0

  identity_type = "IAM"
  iam_arn       = var.admin_iam_arn
  email         = var.notification_email
  user_role     = "ADMIN"

  depends_on = [aws_quicksight_account_subscription.this]
}

check "admin_registration" {
  assert {
    condition     = !(var.register_admin_user && data.aws_caller_identity.current.arn == var.admin_iam_arn)
    error_message = "admin_iam_arn is the identity running Terraform, which CreateAccountSubscription registers as ADMIN itself: set register_admin_user = false before the first apply."
  }
}
