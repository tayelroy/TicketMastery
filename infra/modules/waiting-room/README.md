# modules/waiting-room — UC3 virtual waiting room

**Owner:** Yan Ting · **Code:** [`lambdas/queue-manager`](../../../lambdas/queue-manager/README.md) ·
**API:** `services/ticketmastery-api/src/modules/waiting-room` · **Status:** join + admit deployed by this module.

```
API --SendMessage--> SQS FIFO join-queue (+ DLQ) --> queue-manager --> DynamoDB live-queue <--GetItem-- API
EventBridge Scheduler (rate 1 minute) -----------> queue-manager (admit step)
```

## Resources

| File | Resources |
|---|---|
| `sqs.tf` | `join-queue.fifo`, `join-queue-dlq.fifo` (3 tries) |
| `dynamodb.tf` | `live-queue` (on-demand, TTL `expiresAt`), GSIs `position-index` and `counter-index` (sparse, KEYS_ONLY) |
| `lambda.tf` | `queue-manager` (Python 3.13, private subnets, own SG), log group (14 days), SQS event source mapping |
| `scheduler.tf` | `queue-manager-admit` schedule, its role (`lambda:InvokeFunction` on queue-manager only), async retries off |
| `iam.tf` | `queue-manager-role`; `waiting-room-api-access` on the API task role |

The API task role gets `sqs:SendMessage` on join-queue and `dynamodb:GetItem` on live-queue. That GetItem covers both
`GET /api/waiting-room/:id/status` and checkout's admission check, so admission needs no extra permission.

## Variables

| Name | Default | Notes |
|---|---|---|
| `vpc_id`, `private_subnet_ids` | (required) | Lambda placement; DynamoDB via the gateway endpoint |
| `task_role_name` | (required) | API task role (ecs-service output) |
| `waiting_ttl_seconds` | `21600` | TTL of a waiting fan's row |
| `lambda_timeout` | `30` | join-queue visibility timeout is 6× this |
| `join_trigger_enabled` | `true` | SQS → Lambda trigger |
| `admit_batch_size` | `500` | fans admitted per concert per run |
| `admission_window_seconds` | `900` | how long an admitted fan may hold seats |
| `admit_schedule_enabled` | `true` | `false` pauses the schedule (state `DISABLED`) without deleting it |
| `admit_schedule_start_date`, `admit_schedule_end_date` | `null` | RFC 3339, e.g. `2026-11-09T19:55:00+08:00`; limit the schedule to a sale window |

Outputs: `join_queue_url`, `join_queue_arn`, `join_dlq_url`, `join_dlq_name`, `live_queue_table_name`,
`live_queue_table_arn`, `lambda_sg_id`, `queue_manager_function_name`, `admit_schedule_name`.

## Admit schedule and its cost

Instructor feedback (d) in [docs/architecture.md](../../../docs/architecture.md#instructor-feedback-open-items-not-implemented)
asked us to check what a per-minute EventBridge schedule costs. ESTIMATE for a month with the schedule always on, from
the free tiers and list prices quoted in that table (verify against the AWS pricing pages for the report):

| Item | Usage (`rate(1 minute)`, 30.4 days) | Free tier | Cost |
|---|---|---|---|
| EventBridge Scheduler invocations | 43,800 | 14 M/month | USD 0 (then USD 1.00 per million) |
| Lambda requests | 43,800 | 1 M/month | USD 0 |
| Lambda duration (128 MB, < 1 s per idle run) | ≈ 5,500 GB-s | 400,000 GB-s/month | USD 0 |
| DynamoDB reads per run (counter-index query + 1 consistent GetItem + 1 position-index query per concert) | ≈ 100,000 RRU per concert with a queue | — | a few US cents |
| `WaitingRoomSize` custom metric (EMF) | 1 metric | 10 metrics | USD 0 |
| CloudWatch Logs (≈ 1 KB per run) | ≈ 45 MB | 5 GB | USD 0 |

So an always-on schedule is ≈ USD 0 at our scale, and the free tiers are shared with the rest of the account. Even
so, the module scopes it: set `admit_schedule_start_date`/`admit_schedule_end_date` around a sale, or
`admit_schedule_enabled = false` between demos. Admitting fans costs one DynamoDB write per admitted fan, which is
the same whatever the schedule.

Independently of the schedule dates, queue-manager admits nobody outside each concert's own sale window (the API sends
`saleStartsAt`/`saleEndsAt` with every join), so one schedule serves several concerts with different sales.

## Notes

- `counter-index` was added after `live-queue` was first deployed. Terraform adds the GSI in place (DynamoDB
  backfills it). `#COUNTER` rows written by the earlier code get `rowType` on the next join to that concert; until
  then the admit step doesn't see that concert.
- Scheduler invokes Lambda asynchronously; `aws_lambda_function_event_invoke_config` sets retries to 0 so a failed
  admit run isn't replayed on top of the next scheduled one. The SQS trigger is synchronous and unaffected.
- Alarms (Lambda errors, waiting-room size) live in `modules/monitoring`.
