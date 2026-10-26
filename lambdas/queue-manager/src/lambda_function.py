import json
import os
import time
import boto3

TABLE_NAME = os.environ["TABLE_NAME"]
WAITING_TTL = int(os.environ.get("WAITING_TTL_SECONDS", "21600"))  # 6 hours

table = boto3.resource("dynamodb").Table(TABLE_NAME)


def lambda_handler(event, context):
    # SQS trigger -> assign queue numbers (step 5 on diagram)
    if "Records" in event:
        return handle_join_batch(event["Records"])

    # EventBridge trigger -> admit batch (step 7) -- we add this later
    print("Non-SQS event, ignoring for now:", json.dumps(event))
    return {"status": "ignored"}


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

    # 1. Already in the queue? Skip.
    if "Item" in table.get_item(Key=key, ConsistentRead=True):
        print(f"DUPLICATE {user_id} for {event_id}, skipping")
        return

    # 2. Tear off the next number (atomic +1, creates counter if missing)
    resp = table.update_item(
        Key={"eventId": event_id, "userId": "#COUNTER"},
        UpdateExpression="ADD lastPosition :one",
        ExpressionAttributeValues={":one": 1},
        ReturnValues="UPDATED_NEW",
    )
    position = int(resp["Attributes"]["lastPosition"])

    # 3. Write the user's row -- only if it doesn't already exist
    now = int(time.time())
    try:
        table.put_item(
            Item={
                **key,
                "position": position,
                "status": "WAITING",
                "joinedAt": int(msg.get("joinedAt", now)),
                "expiresAt": now + WAITING_TTL,
            },
            ConditionExpression="attribute_not_exists(userId)",
        )
        print(f"ASSIGNED {user_id} -> #{position} for {event_id}")
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        print(f"DUPLICATE (race) {user_id}, position {position} unused")
