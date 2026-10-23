# Cognito user pool for fans and organisers. Fans self-register (email + code); organisers are added to the
# `organisers` group by an admin only. The API and the gateway accept ACCESS tokens from the `spa` client.

resource "aws_cognito_user_pool" "this" {
  name                     = "${var.name}-users"
  user_pool_tier           = var.user_pool_tier # if `terraform validate` rejects this argument, delete the line (default plan: Essentials)
  username_attributes      = ["email"]          # fans sign in with their email
  auto_verified_attributes = ["email"]          # Cognito emails a code on sign-up
  deletion_protection      = "INACTIVE"         # dev: terraform destroy must work
  mfa_configuration        = "OFF"              # target design: OPTIONAL with TOTP

  # No `schema` block on purpose: changing a pool's schema replaces the pool and deletes every user.

  password_policy {
    minimum_length                   = 10
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT" # 50 emails/day per account; switch to SES (DEVELOPER) later
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your TicketMastery verification code"
    email_message        = "Your TicketMastery code is {####}"
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "spa" {
  name            = "${var.name}-spa"
  user_pool_id    = aws_cognito_user_pool.this.id
  generate_secret = false # a browser app can't keep a secret

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH", # Amplify sign-in; the password never leaves the browser
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_ADMIN_USER_PASSWORD_AUTH", # CLI tests only (admin-initiate-auth); needs IAM credentials
  ]
  prevent_user_existence_errors = "ENABLED" # don't reveal which emails are registered
  enable_token_revocation       = true

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 7
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_group" "organisers" {
  name         = "organisers" # must match ORGANISERS_GROUP in the API (src/auth) and the frontend (src/auth/session.ts)
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Event organisers (UC5). Added by an admin only, never self-service."
}
