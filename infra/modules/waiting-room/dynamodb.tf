# live-queue: one row per user per concert + one #COUNTER row per concert

resource "aws_dynamodb_table" "live_queue" {
  name         = "live-queue"
  billing_mode = "PAY_PER_REQUEST" # on-demand

  hash_key  = "eventId" # PK
  range_key = "userId"  # SK

  # Only key attributes are declared here (table keys + GSI keys).
  # status, expiresAt, lastPosition etc. just appear when code writes them.
  attribute {
    name = "eventId"
    type = "S"
  }

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "position"
    type = "N"
  }

  # "Next N users in order" lookup for the admit-batch job
  global_secondary_index {
    name            = "position-index"
    hash_key        = "eventId"
    range_key       = "position"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  # Encryption: AWS-owned key by default (free).
  # If your team standardises on KMS, uncomment to use the AWS managed key (aws/dynamodb):
  # server_side_encryption {
  #   enabled = true
  # }
}
