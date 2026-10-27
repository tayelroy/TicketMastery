# waiting-room module — UC3 Virtual waiting room

**Owner:** Yan Ting
**Mounted at:** `/api/waiting-room` (registered in `src/modules/index.ts`)
**Status:** join and status implemented. The admit step (queue-manager Part B) is still to come.

## Flow

```
POST /join -> API (Fargate) -> SQS FIFO join-queue -> queue-manager Lambda -> DynamoDB live-queue
GET /status -> API (Fargate) -> DynamoDB live-queue (GetItem)
```

The join message is `{ eventId, userId, joinedAt }` with `MessageGroupId = concertId`, so each concert's
joins reach queue-manager in arrival order. `MessageDeduplicationId` is a hash of `userId#concertId`.

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
number: `200` with their current status, nothing is sent.

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

## Contract for the admit step (queue-manager Part B)

The API already reads these; the admit step must write them:

- `#COUNTER` row: `admittedUpTo` (number), the highest position let in so far.
- Fan row: `status = "ADMITTED"` and `admissionExpiresAt` (epoch seconds), or `status = "EXPIRED"`.

## Known gaps

- Rejoining after `expired` sends a new message, but queue-manager skips fans who already have a row, so
  they keep the old one. Part B should delete or reset the row on expiry.
- `checkout/admission.ts` (Shi Hui) still admits everyone; it can call `getStatus` once Part B exists.
