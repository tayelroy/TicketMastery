# modules/messaging

UC4 e-ticket pipeline (owner: Shi Hui).

```
API --sns:Publish--> SNS order-events --raw--> SQS ticket-queue --> ticket-fn Lambda --> S3 tickets/<orderId>.pdf
                                                     |                       |---------> SES email with the PDF
                                                     +-- 5 failures --> SQS ticket-dlq (alarm)
API (UC2) --HeadObject + pre-signed GetObject--> S3 tickets/<orderId>.pdf
```

| File | Contents |
|---|---|
| `main.tf` | SNS `order-events`, SQS `ticket-queue` + `ticket-dlq`, raw SNS→SQS subscription, API `sns:Publish`, DLQ alarm |
| `ticket_fn.tf` | private e-ticket bucket, SES sender identity, `ticket-fn` Lambda + log group + role + SQS event source mapping, API read access to the PDFs |

Status: SNS/SQS/DLQ deployed; e-ticket bucket, SES identity and `ticket-fn` added on `feat/final-integration`
(not yet applied). Lambda code and its behaviour: [`lambdas/ticket-fn`](../../../lambdas/ticket-fn/README.md).

## Resources

- **SNS `<name>-order-events`**: the API publishes `OrderConfirmed` (checkout) and, when an organiser cancels a concert,
  one `ConcertCancelled` per confirmed order (organiser module); both carry the `eventType` message attribute.
- **SQS `<name>-ticket-queue`** (SSE-SQS, long polling): visibility timeout = 6 × `ticket_fn_timeout_seconds`, as AWS
  recommends for Lambda event sources, so the queue and function timeouts can't drift apart. Redrives to
  **`<name>-ticket-dlq`** (14 days) after `max_receive_count` receives.
- **S3 `<name>-etickets-*`**: private (public access blocked, `BucketOwnerEnforced`, SSE-S3, HTTPS-only bucket policy),
  `force_destroy` for dev. Keys: `tickets/<orderId>.pdf` (the e-ticket), and ticket-fn's idempotency markers written
  after an email went out: `tickets/<orderId>.sent` (e-ticket) and `tickets/<orderId>.cancelled.sent` (cancellation).
- **SES v2 email identity** for `ses_from_address`. Creating it sends the verification email.
- **Lambda `<name>-ticket-fn`** (Node.js 22, arm64, outside the VPC), zipped from the committed bundle
  `lambdas/ticket-fn/bundle/index.js`: plan doesn't run npm. Event source mapping: batch 10,
  `ReportBatchItemFailures`, maximum concurrency 2 (the SES sandbox sends 1 email per second).
- **IAM**: ticket-fn role with SQS receive/delete/attributes on `ticket-queue`, S3 get/put on `tickets/*` + list on the
  bucket, `ses:SendEmail` + `ses:SendRawEmail` limited to `ses:FromAddress = ses_from_address`, `cognito-idp:AdminGetUser` on the pool,
  logs on its own log group. On the API task role: `sns:Publish` on the topic (`messaging-order-events-publish`) and
  `s3:GetObject` on `tickets/*` + `s3:ListBucket` (`messaging-ticket-pdf-read`; listing turns a missing PDF into a
  404, which the API answers with 409 "still being prepared").
- **Alarm `<name>-ticket-dlq-not-empty`**: any message in the DLQ; notifies `alarm_actions` on ALARM and OK.

## Inputs

| Variable | Default | Purpose |
|---|---|---|
| `name` | (required) | Name prefix, e.g. `ticketmastery-dev` |
| `api_task_role_name` | (required) | API task role that gets publish + PDF read |
| `ses_from_address` | (required) | E-ticket sender; becomes an SES email identity |
| `cognito_user_pool_id` | (required) | Fans' pool, passed to ticket-fn as `COGNITO_USER_POOL_ID` |
| `cognito_user_pool_arn` | (required) | Same pool, scopes `cognito-idp:AdminGetUser` |
| `ticket_fn_timeout_seconds` | `60` | Lambda timeout; queue visibility timeout is 6× this |
| `ticket_fn_memory_mb` | `256` | Lambda memory |
| `log_retention_days` | `14` | ticket-fn log group retention |
| `force_destroy` | `true` | Let `terraform destroy` empty the e-ticket bucket |
| `alarm_actions` | `[]` | SNS topics for the DLQ alarm (monitoring's `alerts_topic_arn`) |
| `fallback_recipient_email` | `""` | Testing only: verified address ticket-fn uses for fans without a Cognito user (`FALLBACK_RECIPIENT_EMAIL`) |
| `max_receive_count` | `5` | Receives before a message moves to the DLQ |
| `tags` | `{ Owner = "shihui" }` | Extra tags |

## Outputs

`order_events_topic_arn` (API env `ORDER_EVENTS_TOPIC_ARN`), `ticket_queue_arn`, `ticket_queue_url`,
`ticket_queue_name`, `ticket_dlq_arn`, `ticket_dlq_url`, `ticket_dlq_name`, `ticket_pdf_bucket_name` (API env
`TICKET_PDF_BUCKET`), `ticket_pdf_bucket_arn`, `ticket_fn_function_name`, `ticket_fn_log_group_name`,
`ses_sender_identity_arn`.

## Wiring (envs/dev)

```hcl
module "messaging" {
  source = "../../modules/messaging"

  name                  = local.name
  api_task_role_name    = module.ecs_service.task_role_name
  ses_from_address      = var.ses_from_address
  cognito_user_pool_id  = module.auth_apigw.user_pool_id
  cognito_user_pool_arn = module.auth_apigw.user_pool_arn
  log_retention_days    = var.log_retention_days
  alarm_actions         = [module.monitoring.alerts_topic_arn]
}
```

and in the `ecs_service` module's `extra_environment`:
`TICKET_PDF_BUCKET = module.messaging.ticket_pdf_bucket_name`.

## After apply (manual)

1. Open the "Amazon Web Services – Email Address Verification Request" email sent to `ses_from_address` and click
   the link. Check: `aws sesv2 get-email-identity --email-identity <address>` shows `"VerifiedForSendingStatus": true`.
2. The account is in the SES sandbox: verify every demo fan's address too (SES console → Identities → Create
   identity → Email address, then click the link), or the send fails with `MessageRejected` and the order ends in the
   DLQ. Production access is a go-live step.
3. Test: buy a ticket, then check `tickets/<orderId>.pdf` in the bucket, the email, and My Tickets → Download.
4. Failed e-tickets: inspect `ticket-dlq`, fix the cause, then re-drive (SQS console → `ticket-dlq` → Start DLQ
   redrive). Already-sent orders are skipped, so re-driving is safe.
