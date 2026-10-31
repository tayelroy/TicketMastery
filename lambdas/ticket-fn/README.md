# ticket-fn

UC4 e-tickets (owner: Shi Hui). For every paid order it renders a one-page PDF e-ticket, stores it in S3 for the
UC2 download link, and emails it to the fan through SES.

| | |
|---|---|
| Status | implemented; infrastructure in [`infra/modules/messaging/ticket_fn.tf`](../../infra/modules/messaging/ticket_fn.tf) |
| Runtime | Node.js 22 (`nodejs22.x`, arm64), outside the VPC, 256 MB, 60 s timeout |
| Trigger | SQS `ticket-queue` (fed by SNS `order-events`, raw delivery), batch 10, maximum concurrency 2, `ReportBatchItemFailures` |
| Function name | `ticketmastery-dev-ticket-fn` (`<name>-ticket-fn`) |

## What it does

Per SQS record:

1. Reads the `eventType` message attribute (falls back to the body's `type`). Anything other than `OrderConfirmed`
   (e.g. `ConcertCancelled`) is logged and skipped, and the record counts as handled.
2. Validates the body against `OrderConfirmedEvent` v1 (copied in [`src/event.ts`](src/event.ts) from the publisher,
   [`checkout/events.ts`](../../services/ticketmastery-api/src/modules/checkout/events.ts); keep them in step).
3. Skips the order if the sent marker `tickets/<orderId>.sent` exists (see [Idempotency](#idempotency)).
4. Renders the PDF ([`src/pdf.ts`](src/pdf.ts), pdf-lib): concert title, artist, venue, start time in Singapore time,
   order id with a QR code of it, one line per seat (section, row, seat, ticket type, price), subtotal, booking fee,
   total. Checkout caps an order at 20 seats, which fit on one A4 page.
5. Writes it to `s3://<TICKET_PDF_BUCKET>/tickets/<orderId>.pdf` (`application/pdf`), the key the API's
   [account module](../../services/ticketmastery-api/src/modules/account/README.md) pre-signs for downloads.
6. Looks up the fan's email with Cognito `AdminGetUser` (`Username` = the event's `fanId`: the pool signs in by email,
   so every username is the user's `sub`).
7. Sends a raw MIME email through SES v2 `SendEmail` from `SES_FROM_ADDRESS`, with the PDF attached.
8. Writes the sent marker, then logs one JSON line `{"msg":"e-ticket sent","orderId",...,"occurredAt",...,"deliveryLatencyMs",...}`.

A record that throws (bad JSON, invalid event, S3/Cognito/SES error) is logged with `level: "error"` and returned in
`batchItemFailures`, so SQS redelivers only that record. After 5 receives (`max_receive_count`) it moves to
`ticket-dlq`, which raises the `ticket-dlq-not-empty` alarm.

## Idempotency

SNS and SQS deliver at least once, so the same order can arrive twice. The rule is: **never drop an email, and send
it once in the normal case**.

- The sent marker `tickets/<orderId>.sent` is written only **after** SES accepted the email, and checked before
  anything else. A redelivery of a sent order does nothing.
- If anything fails before or during the send, there is no marker, so the retry renders and sends again: the email
  is never lost.
- The PDF is overwritten on a retry rather than written with `If-None-Match: *`: the content is the same (the PDF's
  dates are fixed to `occurredAt`), and a conditional write that marks "done" before the email is sent would drop
  the email if the function failed in between.
- Accepted duplicates: a crash between the send and the marker write, or two copies of one message processed at the
  same moment (SQS standard queues rarely do this), each send a second email.

## Delivery latency (NFR-7)

The `e-ticket sent` line is also a CloudWatch Embedded Metric Format record: metric
`TicketMastery/ETicketDeliveryLatency` (Milliseconds, no dimensions), from the event's `occurredAt` (order confirmed)
to SES accepting the email. Logs go to stdout as plain JSON lines (not `console.log`, whose prefix would stop EMF
parsing). Logs Insights on `/aws/lambda/ticketmastery-dev-ticket-fn`:

```
filter msg = "e-ticket sent"
| stats count() as emails, pct(deliveryLatencyMs, 95) as p95_ms, max(deliveryLatencyMs) as max_ms
```

## Configuration

| Variable | Source (Terraform) |
|---|---|
| `TICKET_PDF_BUCKET` | e-ticket bucket created by the messaging module |
| `SES_FROM_ADDRESS` | messaging variable `ses_from_address` |
| `COGNITO_USER_POOL_ID` | messaging variable `cognito_user_pool_id` |

All three are required; the function fails at start-up without them. Region and credentials come from the runtime.

IAM (role `<name>-ticket-fn`): `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on `ticket-queue`;
`s3:GetObject/PutObject` on `tickets/*` and `s3:ListBucket` on the bucket (so a missing marker is a 404, not a 403);
`ses:SendEmail` on `identity/*` with `ses:FromAddress` = the sender (the sandbox also authorises recipient
identities); `cognito-idp:AdminGetUser` on the pool; `logs:CreateLogStream/PutLogEvents` on its log group.

## SES sandbox

The account is in the SES sandbox (checked 2026-10-31: 200 emails per 24 h, 1 email per second):

- The sender **and every recipient** must be verified SES identities. Terraform creates the sender identity, which
  emails a verification link to `ses_from_address`; each demo fan's address has to be verified in the SES console
  (Identities → Create identity → Email address) and its link clicked. Mail to an unverified address fails with
  `MessageRejected` and the record ends in the DLQ.
- 1 email per second: the SDK retries throttling up to 6 attempts, and the event source mapping runs at most 2
  invocations, each handling its records one at a time.
- Production access (SES console → Account dashboard → Request production access) lifts both limits; it is a go-live
  step, not done for the demo.
- A `@gmail.com` sender isn't authenticated by SES's DKIM for gmail.com, so some providers put the email in spam.
  A verified domain identity fixes that in production.

## Build and test

```bash
cd lambdas/ticket-fn
npm ci
npm run typecheck
npm test          # node:test with mocked S3, SES and Cognito clients
npm run build     # esbuild -> bundle/index.js
```

`bundle/index.js` is **committed**: Terraform zips it with `archive_file`, so `terraform plan` never runs npm. After
changing `src/` or the dependencies, run `npm run build` and commit the new bundle with the change. The bundle leaves
out the AWS SDK v3 (`@aws-sdk/*`), which the `nodejs22.x` runtime provides; pdf-lib, qrcode and zod are bundled.
The zip goes to `dist/` (gitignored).
