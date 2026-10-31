# Monitoring and alerts (proposal "Monitoring and Alert Settings", adapted to the built stack):
#   CloudWatch alarms (alarms.tf) --alarm/ok--> SNS <name>-alerts --> email
#   AWS Budgets --> email (directly; Budgets doesn't need the topic)
#   One CloudWatch dashboard (dashboard.tf) with a widget per alarm signal.

################################################################################
# Alert topic
################################################################################

# Not KMS-encrypted: CloudWatch alarms can't publish to a topic encrypted with the AWS-managed SNS key, and a
# customer-managed key (USD 1/month) buys nothing for alert text that holds no personal data. The default topic
# policy already lets CloudWatch alarms in this account publish.
resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"

  tags = merge(var.tags, {
    Name = "${var.name}-alerts"
  })
}

# Stays "PendingConfirmation" until the recipient clicks the link in the AWS confirmation email.
resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

################################################################################
# Checkout failures (log metric filters on the API's pino request logs)
################################################################################

# pino-http logs one JSON line per request with req.method, req.url (Express originalUrl) and res.statusCode.
# POST /api/checkout/holds/<id>/confirm is the payment step: 200 = paid, 402 = payment_failed (declined).
# Other statuses there (404, 409 expired/cancelled) never reached the payment step, so they count as neither.
locals {
  confirm_request = "$.req.method = \"POST\" && $.req.url = \"/api/checkout/holds/*/confirm\""
}

resource "aws_cloudwatch_log_metric_filter" "checkout_attempts" {
  name           = "${var.name}-checkout-payment-attempts"
  log_group_name = var.api_log_group_name
  pattern        = "{ ${local.confirm_request} && ($.res.statusCode = 200 || $.res.statusCode = 402) }"

  metric_transformation {
    namespace = "TicketMastery"
    name      = "CheckoutPaymentAttempts"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "checkout_failures" {
  name           = "${var.name}-checkout-payment-failures"
  log_group_name = var.api_log_group_name
  pattern        = "{ ${local.confirm_request} && $.res.statusCode = 402 }"

  metric_transformation {
    namespace = "TicketMastery"
    name      = "CheckoutPaymentFailures"
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# AWS Budgets
################################################################################

# Account-wide (the account only runs TicketMastery), so no cost-allocation tag has to be activated first.
# Budget emails go straight to the address; they need no subscription confirmation.
resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-monthly-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_alert_thresholds_usd

    content {
      notification_type          = "ACTUAL"
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "ABSOLUTE_VALUE"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = var.budget_limit_usd
    threshold_type             = "ABSOLUTE_VALUE"
    subscriber_email_addresses = [var.alert_email]
  }
}
