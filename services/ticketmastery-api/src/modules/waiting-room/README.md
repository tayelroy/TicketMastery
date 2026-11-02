# waiting-room module — UC3 Virtual waiting room

**Owner:** Yan Ting
**Mounted at:** `/api/waiting-room` (registered in `src/modules/index.ts`)
**Status:** join, status and admission implemented. queue-manager admits fans every minute (EventBridge Scheduler);
checkout lets only admitted fans hold seats.

## Flow

```
POST /join -> API (Fargate) -> SQS FIFO join-queue -> queue-manager Lambda -> DynamoDB live-queue
GET /status -> API (Fargate) -> DynamoDB live-queue (GetItem)
EventBridge Scheduler (every minute) -> queue-manager -> live-queue: next 500 WAITING -> ADMITTED (15 minutes)
POST /api/checkout/holds -> checkout/admission.ts -> live-queue (GetItem): 403 not_admitted unless admitted
```

The join message is `{ eventId, userId, joinedAt, saleStartsAt, saleEndsAt }` (epoch seconds) with
`MessageGroupId = concertId`, so each concert's joins reach queue-manager in arrival order.
`MessageDeduplicationId` is a hash of `userId#concertId`. queue-manager has no database access, so the sale window
travels with the join and it admits nobody before the sale opens or after it ends.

## Endpoints

All routes need a signed-in fan (any user; no group). `401` when anonymous.

Both return the same body:

```json
{ "concertId": "…", "state": "waiting", "position": 1248, "peopleAhead": 1031, "admittedUntil": null }
```

| `state` | Meaning |
|---|---|
| `pending` | join sent, queue-manager hasn't assigned a number yet (poll again) |
| `waiting` | has a number; `peopleAhead` = position − 1 − `admittedUpTo` |
| `admitted` | may check out until `admittedUntil` |
| `expired` | admission window passed |

### `POST /api/waiting-room/:concertId/join`

Sends the join to SQS. `202` with `state: "pending"`. A fan who is already waiting or admitted keeps their
number: `200` with their current status, nothing is sent. A fan whose admission expired joins again at the back.

| Status | `error.code` | When |
|---|---|---|
| 400 | `validation_error` | concertId isn't a uuid |
| 404 | `not_found` | no such concert |
| 409 | `not_joinable` | concert not `scheduled`/`on_sale`, or its sale has ended |
| 501 | `not_implemented` | env vars unset (local dev); the frontend shows its demo queue |

### `GET /api/waiting-room/:concertId/status`

Reads the fan's row and the concert's `#COUNTER` row. Poll every few seconds.

## Configuration

Set on the ECS task by `infra/envs/dev/main.tf` (`extra_environment`). Unset locally, so both routes return `501`.

| Variable | From |
|---|---|
| `WAITING_ROOM_JOIN_QUEUE_URL` | `module.waiting_room.join_queue_url` |
| `WAITING_ROOM_TABLE_NAME` | `module.waiting_room.live_queue_table_name` |

The task role gets `sqs:SendMessage` on join-queue and `dynamodb:GetItem` on live-queue
(`infra/modules/waiting-room/iam.tf`). Tasks run in public subnets, so no VPC endpoint is needed.

## live-queue data model

Written by [queue-manager](../../../../../lambdas/queue-manager/README.md#live-queue-data-model), read here
(`queue.ts`, mapped by `status.ts`):

- `#COUNTER` row: `lastPosition`, `admittedUpTo` (the highest position let in so far).
- Fan row: `position`, `status = "WAITING"`, then `status = "ADMITTED"` with `admissionExpiresAt` (epoch seconds).
  `ADMITTED` past `admissionExpiresAt` (or `EXPIRED`) shows as `expired`.

Checkout's admission check (`checkout/admission.ts`) uses the same mapping, so a fan the status says is `admitted`
can hold seats, and nobody else can.

## Known gaps

- `peopleAhead` counts unused numbers (rare join races) and fans who left, so it can overstate the wait slightly.
