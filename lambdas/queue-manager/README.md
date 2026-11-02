# queue-manager — UC3 virtual waiting room

**Owner:** Yan Ting · **Runtime:** Python 3.13, `lambda_function.lambda_handler` · **Infra:**
[`infra/modules/waiting-room`](../../infra/modules/waiting-room/README.md) · **Status:** join and admit implemented.

One function, two triggers:

| Trigger | Event | Does |
|---|---|---|
| SQS FIFO `join-queue` (batch 10, partial batch failures) | has `Records` | **Join** (step 5): gives each fan the next queue number in DynamoDB `live-queue` |
| EventBridge Scheduler `queue-manager-admit`, `rate(1 minute)` | anything else | **Admit** (step 7): lets in the next `ADMIT_BATCH_SIZE` waiting fans per concert, emits `WaitingRoomSize` |

## live-queue data model

Shared with the API (`services/ticketmastery-api/src/modules/waiting-room/queue.ts` and `status.ts`).

| Row (PK `eventId` = concert id, SK `userId`) | Attributes |
|---|---|
| Fan (`userId` = Cognito `sub`) | `position`, `status` (`WAITING` → `ADMITTED`), `joinedAt`, `expiresAt` (TTL), `admissionExpiresAt` once admitted |
| `#COUNTER` (one per concert) | `lastPosition` (last number handed out), `admittedUpTo` (highest position admitted), `rowType = "COUNTER"`, `saleStartsAt` / `saleEndsAt` (epoch seconds, from the join message) |

Indexes: `position-index` (eventId + position, ALL) gives "the next N in order"; `counter-index` (rowType,
KEYS_ONLY, sparse) lists the concerts that have a queue without scanning every fan row.

## Join (SQS)

Message body (sent by the API): `{ eventId, userId, joinedAt, saleStartsAt, saleEndsAt }`.

1. A fan who already has a row keeps it (repeat clicks, redelivery). Exception: a fan whose admission ran out
   (`ADMITTED` past `admissionExpiresAt`, or `EXPIRED`) rejoins at the back with a new number.
2. Atomic `ADD lastPosition 1` on `#COUNTER` (also stores the sale window, refreshed by every join).
3. Conditional put of the fan row as `WAITING`. A lost race leaves an unused number, never two rows.

If a record fails, it and every record after it are returned as `batchItemFailures`, so nobody behind it jumps
the queue. After 3 failures SQS moves the message to `join-queue-dlq.fifo`.

## Admit (scheduled)

For every concert in `counter-index`:

1. Read `#COUNTER` (consistent). Skip the concert outside its sale window (`saleStartsAt` ≤ now < `saleEndsAt`), so
   fans who queue early aren't admitted, and then timed out, before tickets go on sale.
2. Query `position-index` for positions after `admittedUpTo − RECHECK_POSITIONS`, lowest first, and admit
   `WAITING` rows until `ADMIT_BATCH_SIZE` are in: `status = ADMITTED`, `admissionExpiresAt = now + 15 min`, TTL
   pushed past the admission. Each update is conditional on `status = WAITING`, so overlapping runs never admit
   anyone twice. The look-back catches a fan whose index entry arrived late (GSIs are eventually consistent).
3. Move `admittedUpTo` forward (conditional, never backwards). The API shows `peopleAhead = position − 1 − admittedUpTo`.

One concert failing doesn't stop the others; the run then raises so the Lambda `Errors` metric (and alarm) sees it.
Failed runs aren't retried (the next one is a minute away).

The API's checkout (`checkout/admission.ts`) lets a fan hold seats only while their row is `ADMITTED` and
`admissionExpiresAt` hasn't passed; otherwise `403 not_admitted`.

### `WaitingRoomSize` metric

Every admit run prints one [Embedded Metric Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html)
line: namespace `TicketMastery`, metric `WaitingRoomSize` (Count, no dimensions) = fans still waiting across all
concerts (`lastPosition − admittedUpTo` per concert, so unused numbers from join races count too). CloudWatch Logs
turns the line into the metric; the function is in the VPC without NAT, so it can't call `PutMetricData`.

## Environment variables

| Name | Default | Set by Terraform from |
|---|---|---|
| `TABLE_NAME` | (required) | `aws_dynamodb_table.live_queue.name` |
| `WAITING_TTL_SECONDS` | `21600` | `waiting_ttl_seconds` |
| `ADMIT_BATCH_SIZE` | `500` | `admit_batch_size` |
| `ADMISSION_WINDOW_SECONDS` | `900` | `admission_window_seconds` |
| `RECHECK_POSITIONS` | `100` | (not set) |

## IAM

`queue-manager-role`: `AWSLambdaVPCAccessExecutionRole` (logs, VPC ENIs); `sqs:ReceiveMessage/DeleteMessage/
GetQueueAttributes` on `join-queue`; `dynamodb:GetItem/PutItem/UpdateItem/Query` on `live-queue` and its indexes.
The scheduler has its own role with only `lambda:InvokeFunction` on this function.

## Build and test

Terraform zips `src/` (`archive_file`) on plan/apply; there are no dependencies beyond boto3, which the runtime
provides. Tests use only the standard library (boto3 is replaced by an in-memory table):

```bash
cd lambdas/queue-manager && python3 -m unittest discover -s tests
```

Run the admit step by hand (any non-SQS payload):

```bash
aws lambda invoke --function-name queue-manager --cli-binary-format raw-in-base64-out --payload '{}' /dev/stdout
```
