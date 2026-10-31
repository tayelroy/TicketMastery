import json
import os
import time
import boto3

TABLE_NAME = os.environ["TABLE_NAME"]
WAITING_TTL = int(os.environ.get("WAITING_TTL_SECONDS", "21600"))  # 6 hours
ADMIT_BATCH_SIZE = int(os.environ.get("ADMIT_BATCH_SIZE", "500"))
ADMISSION_SECONDS = int(os.environ.get("ADMISSION_WINDOW_SECONDS", "900"))  # 15 minutes

# GSI writes are eventually consistent, so a fan written just before a run may be missing from position-index
# while fans behind them are already there. Each run looks this many places back to admit such stragglers.
RECHECK_POSITIONS = int(os.environ.get("RECHECK_POSITIONS", "100"))

COUNTER = "#COUNTER"
COUNTER_INDEX = "counter-index"  # sparse: only #COUNTER rows carry rowType
METRIC_NAMESPACE = "TicketMastery"

table = boto3.resource("dynamodb").Table(TABLE_NAME)


def lambda_handler(event, context):
    # SQS trigger -> assign queue numbers (step 5 on diagram)
    if "Records" in event:
        return handle_join_batch(event["Records"])

    # EventBridge Scheduler (or a manual test invoke) -> admit the next batch (step 7)
    return admit_all()


def handle_join_batch(records):
    for i, record in enumerate(records):
        try:
            assign_position(json.loads(record["body"]))
        except Exception as e:
            print(f"FAILED {record['messageId']}: {e}")
            # FIFO rule: if one fails, retry it AND everything after it,
            # so nobody behind it jumps the queue
            return {"batchItemFailures": [
                {"itemIdentifier": r["messageId"]} for r in records[i:]
            ]}
    return {"batchItemFailures": []}


def assign_position(msg):
    event_id = msg["eventId"]
    user_id = msg["userId"]
    key = {"eventId": event_id, "userId": user_id}

    # 1. Already in the queue? Skip -- unless their admission ran out, then they rejoin at the back.
    now = int(time.time())
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    if existing and not admission_over(existing, now):
        print(f"DUPLICATE {user_id} for {event_id}, skipping")
        return

    # 2. Tear off the next number (atomic +1, creates counter if missing).
    # rowType puts the counter in counter-index so the admit step can list concerts without a Scan. The sale
    # window comes from the API (queue-manager has no database access) and is refreshed by every join, so a
    # sale the organiser moves is picked up by the next fan who joins.
    names = {"#rowType": "rowType"}
    values = {":one": 1, ":counter": "COUNTER"}
    sets = ["#rowType = :counter"]
    for attr in ("saleStartsAt", "saleEndsAt"):
        if msg.get(attr) is not None:
            names[f"#{attr}"] = attr
            values[f":{attr}"] = int(msg[attr])
            sets.append(f"#{attr} = :{attr}")
    resp = table.update_item(
        Key={"eventId": event_id, "userId": COUNTER},
        UpdateExpression=f"SET {', '.join(sets)} ADD lastPosition :one",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ReturnValues="UPDATED_NEW",
    )
    position = int(resp["Attributes"]["lastPosition"])

    # 3. Write the user's row -- only if nobody else wrote it since step 1
    if existing:
        condition = {
            "ConditionExpression": "#position = :seen",
            "ExpressionAttributeNames": {"#position": "position"},
            "ExpressionAttributeValues": {":seen": existing["position"]},
        }
    else:
        condition = {"ConditionExpression": "attribute_not_exists(userId)"}
    try:
        table.put_item(
            Item={
                **key,
                "position": position,
                "status": "WAITING",
                "joinedAt": int(msg.get("joinedAt", now)),
                "expiresAt": now + WAITING_TTL,
            },
            **condition,
        )
        print(f"ASSIGNED {user_id} -> #{position} for {event_id}" + (" (rejoined)" if existing else ""))
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        print(f"DUPLICATE (race) {user_id}, position {position} unused")


def admission_over(row, now):
    if row.get("status") == "EXPIRED":
        return True
    return row.get("status") == "ADMITTED" and int(row.get("admissionExpiresAt", now + 1)) <= now


# ---------- Admit step (scheduled) ----------


def admit_all(now=None):
    """Admits up to ADMIT_BATCH_SIZE waiting fans per concert, then reports how many are still waiting."""
    now = int(time.time()) if now is None else now
    admitted = 0
    waiting = 0
    failed = []
    for event_id in concerts_with_queue():
        try:
            result = admit_next(event_id, now)
        except Exception as e:
            # One concert's failure mustn't stall the others; the run still fails below so the Lambda Errors
            # alarm sees it.
            print(f"ADMIT FAILED for {event_id}: {e}")
            failed.append(event_id)
            continue
        admitted += result["admitted"]
        waiting += result["waiting"]

    emit_waiting_room_size(waiting)
    print(f"ADMIT RUN admitted={admitted} waiting={waiting} failed={len(failed)}")
    if failed:
        raise RuntimeError(f"admit failed for {len(failed)} concert(s): {', '.join(failed)}")
    return {"status": "ok", "admitted": admitted, "waiting": waiting}


def concerts_with_queue():
    kwargs = {
        "IndexName": COUNTER_INDEX,
        "KeyConditionExpression": "#rowType = :counter",
        "ExpressionAttributeNames": {"#rowType": "rowType"},
        "ExpressionAttributeValues": {":counter": "COUNTER"},
    }
    while True:
        page = table.query(**kwargs)
        for item in page.get("Items", []):
            yield item["eventId"]
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def admit_next(event_id, now):
    """Admits the next batch for one concert in position order. Returns counts for the run summary."""
    counter = table.get_item(Key={"eventId": event_id, "userId": COUNTER}, ConsistentRead=True).get("Item", {})
    last = int(counter.get("lastPosition", 0))
    admitted_up_to = int(counter.get("admittedUpTo", 0))
    if not sale_open(counter, now):
        return {"admitted": 0, "waiting": max(0, last - admitted_up_to)}

    expires_at = now + ADMISSION_SECONDS
    admitted = 0
    highest = admitted_up_to
    for row in waiting_rows(event_id, after=max(0, admitted_up_to - RECHECK_POSITIONS)):
        if admit(row, expires_at):
            admitted += 1
            highest = max(highest, int(row["position"]))
        if admitted >= ADMIT_BATCH_SIZE:
            break

    if highest > admitted_up_to:
        advance_counter(event_id, highest)
    return {"admitted": admitted, "waiting": max(0, last - highest)}


def sale_open(counter, now):
    # Counters written before the API sent the sale window have neither field: treat the sale as open, which is
    # what limiting the schedule to the sale window (start/end dates in Terraform) already assumes.
    starts = counter.get("saleStartsAt")
    ends = counter.get("saleEndsAt")
    return (starts is None or now >= int(starts)) and (ends is None or now < int(ends))


def waiting_rows(event_id, after):
    """WAITING fans of one concert with position > after, lowest position first, read page by page."""
    kwargs = {
        "IndexName": "position-index",
        "KeyConditionExpression": "eventId = :e AND #position > :after",
        "ExpressionAttributeNames": {"#position": "position"},
        "ExpressionAttributeValues": {":e": event_id, ":after": after},
        "ScanIndexForward": True,
        "Limit": ADMIT_BATCH_SIZE + RECHECK_POSITIONS,
    }
    while True:
        page = table.query(**kwargs)
        for item in page.get("Items", []):
            if item.get("status") == "WAITING":
                yield item
        if "LastEvaluatedKey" not in page:
            return
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def admit(row, admission_expires_at):
    """WAITING -> ADMITTED. False if the row changed meanwhile (overlapping run, or TTL removed it)."""
    # The row's TTL must not delete it while the fan is still admitted.
    ttl = max(int(row.get("expiresAt", 0)), admission_expires_at)
    try:
        table.update_item(
            Key={"eventId": row["eventId"], "userId": row["userId"]},
            UpdateExpression="SET #status = :admitted, admissionExpiresAt = :until, expiresAt = :ttl",
            ConditionExpression="#status = :waiting",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":admitted": "ADMITTED",
                ":waiting": "WAITING",
                ":until": admission_expires_at,
                ":ttl": ttl,
            },
        )
        return True
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return False


def advance_counter(event_id, admitted_up_to):
    # Only ever moves forward, so an overlapping slower run can't pull it back.
    try:
        table.update_item(
            Key={"eventId": event_id, "userId": COUNTER},
            UpdateExpression="SET admittedUpTo = :v",
            ConditionExpression="attribute_not_exists(admittedUpTo) OR admittedUpTo < :v",
            ExpressionAttributeValues={":v": admitted_up_to},
        )
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        pass


def emit_waiting_room_size(waiting):
    # Embedded Metric Format: CloudWatch Logs turns this line into a metric. queue-manager runs in the VPC without
    # NAT, so it can't reach the CloudWatch API for PutMetricData.
    print(json.dumps({
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": METRIC_NAMESPACE,
                "Dimensions": [[]],
                "Metrics": [{"Name": "WaitingRoomSize", "Unit": "Count"}],
            }],
        },
        "WaitingRoomSize": waiting,
    }))
