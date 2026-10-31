# ticket-fn — UC4 e-tickets

**Owner:** Shi Hui
**Runtime:** Python 3.13, no third-party packages (boto3 comes with Lambda). Terraform zips `src/` on plan/apply.
**Infra:** `infra/modules/messaging/ticket_fn.tf`

```
API checkout --OrderConfirmed--> SNS order-events --> SQS ticket-queue --> ticket-fn --> S3 tickets/<orderId>.pdf
UC5 cancel ---ConcertCancelled-->      (same)              |                        \--> SES email to the fan
                                              after 5 failed tries --> SQS ticket-dlq (+ CloudWatch alarm)
```

## What it does

| Event (`type`) | Effect |
|---|---|
| `OrderConfirmed` | Renders a PDF (order summary + one page per seat), stores it at `tickets/<orderId>.pdf`, emails it as an attachment. |
| `ConcertCancelled` | Emails the fan that the concert is cancelled, with the reason and refund amount. |
| anything else | Logged (`SKIPPED`) and dropped. |

- **Once per order:** delivery is at-least-once, so after a successful send it writes `sent/<order-confirmed|concert-cancelled>/<orderId>.json`
  and skips the event if that marker already exists (`DUPLICATE` in the logs).
- **Retries:** each SQS message succeeds or fails on its own (`ReportBatchItemFailures`). A failed one is retried
  after the visibility timeout; after 5 tries it goes to `ticket-dlq`, which raises the `ticket-dlq-not-empty` alarm.
- **Recipient:** `fanId` is the Cognito `sub`, which is also the username (the pool signs in by email), so the email
  comes from `AdminGetUser`. With `AUTH_MODE=dev-header` fan ids are made up (`fan-1`), so `FALLBACK_RECIPIENT_EMAIL`
  is used when there is no Cognito user.
- **SES sandbox:** only verified addresses can send or receive. An unverified recipient logs
  `SES REJECTED (sandbox: is the recipient verified in SES?)` and the message retries, then lands in the DLQ.
  Verify the address in SES, then re-drive the DLQ (console: SQS → ticket-dlq → Start DLQ redrive).

## Environment variables

| Name | Set by | Meaning |
|---|---|---|
| `TICKET_BUCKET` | Terraform | private e-ticket bucket |
| `SENDER_EMAIL` | `ses_sender_email` tfvar | verified SES identity the email comes from |
| `USER_POOL_ID` | Terraform (auth module) | Cognito pool to look up the fan's email |
| `FALLBACK_RECIPIENT_EMAIL` | `ticket_fallback_recipient_email` tfvar, optional | testing only: verified address used when the fan has no Cognito user |

## IAM (least privilege)

`s3:PutObject` / `s3:GetObject` on the bucket's objects, `s3:ListBucket` on the bucket (so a missing marker is a 404,
not a 403), `cognito-idp:AdminGetUser` on the pool, `ses:SendRawEmail` from `SENDER_EMAIL` only, the SQS
receive/delete permissions for ticket-queue, and CloudWatch Logs. Runs outside the VPC (no NAT needed for SES/Cognito).

## Events

`OrderConfirmed` (v1) is published by the API: see `OrderConfirmedEvent` in
`services/ticketmastery-api/src/modules/checkout/events.ts`.

`ConcertCancelled` (v1) — **proposed contract for UC5**: publish **one message per confirmed order** of the cancelled
concert to the `order-events` topic (`ORDER_EVENTS_TOPIC_ARN`), with message attribute `eventType = ConcertCancelled`:

```json
{
  "type": "ConcertCancelled",
  "version": 1,
  "occurredAt": "2026-11-01T08:00:00.000Z",
  "orderId": "<uuid>",
  "fanId": "<cognito sub>",
  "concert": { "id": "<uuid>", "title": "…", "artist": "…", "venueName": "…", "startsAt": "<ISO>" },
  "reason": "Artist illness",
  "currency": "SGD",
  "totalCents": 26400
}
```

One message per order keeps each email retrying on its own and stays far below SNS's 256 KB limit whatever the
concert size. ticket-fn has no database access, so the message must carry everything in the email.

## Tests

From `lambdas/ticket-fn`, in the same image Lambda runs (fake AWS clients, no network):

```bash
MSYS_NO_PATHCONV=1 docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD":/fn:ro -w /fn \
  --entrypoint python3 public.ecr.aws/lambda/python:3.13 -m unittest discover -s tests -v
```

`PYTHONDONTWRITEBYTECODE` keeps `__pycache__` out of `src/`, which Terraform zips.

## Trying it in AWS

After `terraform apply`, check out and pay as a fan (or publish by hand):

```bash
aws sns publish --topic-arn "$(terraform -chdir=infra/envs/dev output -raw order_events_topic_arn)" \
  --message file://order-confirmed.json --message-attributes 'eventType={DataType=String,StringValue=OrderConfirmed}'
aws logs tail /aws/lambda/ticketmastery-dev-ticket-fn --follow
```
