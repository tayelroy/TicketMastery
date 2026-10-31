"""ticket-fn (UC4, Shi Hui): SQS ticket-queue -> e-ticket PDF in S3 + email via SES.

Messages arrive from SNS order-events with raw delivery, so each SQS body is exactly the JSON the publisher sent:
- OrderConfirmed (API checkout, events.ts): render the e-tickets, store them in S3, email them as a PDF attachment.
- ConcertCancelled (UC5, one message per confirmed order): email the fan that the concert is off.
Anything else is logged and skipped.

Delivery is at-least-once, so each (event type, order) is sent once: a marker object in the bucket records it.
A failed message is reported back to SQS on its own (ReportBatchItemFailures) and retried; after max_receive_count
tries it moves to ticket-dlq.
"""

import json
import os
from datetime import datetime, timezone
from email.message import EmailMessage

import boto3
from botocore.exceptions import ClientError

from ticket_pdf import format_money, format_start, render_tickets

# Created on first use and kept between invocations; tests put fakes in here.
_clients = {}


def client(name):
    if name not in _clients:
        _clients[name] = boto3.client(name)
    return _clients[name]


def env(name):
    return os.environ.get(name, "").strip()


class RecipientNotFound(Exception):
    pass


def lambda_handler(event, context):
    failures = []
    for record in event.get("Records", []):
        try:
            handle_message(json.loads(record["body"]))
        except Exception as e:
            print(f"FAILED {record['messageId']}: {type(e).__name__}: {e}")
            failures.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failures}


def handle_message(msg):
    handler = HANDLERS.get(msg.get("type"))
    if handler is None:
        print(f"SKIPPED unknown event type {msg.get('type')!r}")
        return
    handler(msg)


def handle_order_confirmed(msg):
    order_id = msg["orderId"]
    marker = f"sent/order-confirmed/{order_id}.json"
    if already_sent(marker):
        print(f"DUPLICATE OrderConfirmed {order_id}: e-tickets already sent")
        return

    pdf = render_tickets(msg)
    pdf_key = f"tickets/{order_id}.pdf"
    client("s3").put_object(Bucket=env("TICKET_BUCKET"), Key=pdf_key, Body=pdf, ContentType="application/pdf")

    concert = msg["concert"]
    count = len(msg["seats"])
    seat_lines = [f"  - {s['section']}, Row {s['row']}, Seat {s['seatNumber']} ({s['ticketType']})" for s in msg["seats"]]
    body = "\n".join(
        [
            "Thanks for your order! Your e-tickets are attached as a PDF, one page per seat.",
            "",
            f"{concert['title']} - {concert['artist']}",
            f"{concert['venueName']}",
            f"{format_start(concert['startsAt'])}",
            "",
            *seat_lines,
            "",
            f"Total paid: {format_money(msg['totalCents'], msg['currency'])}",
            f"Order: {order_id}",
            "",
            "Show each ticket page at the entrance.",
            "TicketMastery",
        ]
    )
    message_id = send_email(
        recipient_for(msg["fanId"]),
        f"Your {'ticket' if count == 1 else f'{count} tickets'} for {concert['title']}",
        body,
        attachment=(f"tickets-{order_id[:8]}.pdf", pdf),
    )
    mark_sent(marker, msg, message_id, pdf_key)
    print(f"SENT OrderConfirmed {order_id}: {count} ticket(s) to fan {msg['fanId']}, SES {message_id}")


def handle_concert_cancelled(msg):
    order_id = msg["orderId"]
    marker = f"sent/concert-cancelled/{order_id}.json"
    if already_sent(marker):
        print(f"DUPLICATE ConcertCancelled {order_id}: notice already sent")
        return

    concert = msg["concert"]
    reason = (msg.get("reason") or "").strip()
    body = "\n".join(
        [
            f"We're sorry: {concert['title']} ({concert['artist']}) at {concert['venueName']}, "
            f"{format_start(concert['startsAt'])}, has been cancelled by the organiser.",
            *([f"Reason: {reason}"] if reason else []),
            "",
            f"Your tickets for order {order_id} are no longer valid. "
            f"You will be refunded {format_money(msg['totalCents'], msg['currency'])}.",
            "",
            "TicketMastery",
        ]
    )
    message_id = send_email(recipient_for(msg["fanId"]), f"Cancelled: {concert['title']}", body)
    mark_sent(marker, msg, message_id)
    print(f"SENT ConcertCancelled {order_id} to fan {msg['fanId']}, SES {message_id}")


HANDLERS = {
    "OrderConfirmed": handle_order_confirmed,
    "ConcertCancelled": handle_concert_cancelled,
}


def already_sent(key):
    try:
        client("s3").head_object(Bucket=env("TICKET_BUCKET"), Key=key)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def mark_sent(key, msg, ses_message_id, pdf_key=None):
    record = {
        "type": msg["type"],
        "orderId": msg["orderId"],
        "fanId": msg["fanId"],
        "sesMessageId": ses_message_id,
        "sentAt": datetime.now(timezone.utc).isoformat(),
        **({"pdfKey": pdf_key} if pdf_key else {}),
    }
    client("s3").put_object(
        Bucket=env("TICKET_BUCKET"), Key=key, Body=json.dumps(record).encode(), ContentType="application/json"
    )


def recipient_for(fan_id):
    """The fan's email from Cognito. fanId is the Cognito sub, which is also the username (the pool signs in by email).

    With AUTH_MODE=dev-header the fan id is made up (e.g. 'fan-1') and has no Cognito user, so FALLBACK_RECIPIENT_EMAIL
    (a verified SES address, testing only) is used instead when set.
    """
    pool_id = env("USER_POOL_ID")
    if pool_id:
        try:
            user = client("cognito-idp").admin_get_user(UserPoolId=pool_id, Username=fan_id)
            email = next((a["Value"] for a in user["UserAttributes"] if a["Name"] == "email"), None)
            if email:
                return email
        except ClientError as e:
            if e.response["Error"]["Code"] != "UserNotFoundException":
                raise
    fallback = env("FALLBACK_RECIPIENT_EMAIL")
    if fallback:
        print(f"NO COGNITO EMAIL for fan {fan_id}; using FALLBACK_RECIPIENT_EMAIL")
        return fallback
    raise RecipientNotFound(f"no email for fan {fan_id} (no Cognito user, FALLBACK_RECIPIENT_EMAIL unset)")


def send_email(to, subject, text, attachment=None):
    sender = env("SENDER_EMAIL")
    if not sender:
        raise RuntimeError("SENDER_EMAIL is not set (terraform variable ses_sender_email)")

    mail = EmailMessage()
    mail["From"] = f"TicketMastery <{sender}>"
    mail["To"] = to
    mail["Subject"] = subject
    mail.set_content(text)
    if attachment:
        filename, data = attachment
        mail.add_attachment(data, maintype="application", subtype="pdf", filename=filename)

    try:
        result = client("ses").send_raw_email(Source=sender, Destinations=[to], RawMessage={"Data": mail.as_bytes()})
    except ClientError as e:
        if e.response["Error"]["Code"] == "MessageRejected":
            # Not a pipeline bug: in the SES sandbox both sender and recipient must be verified identities.
            print(f"SES REJECTED (sandbox: is the recipient verified in SES?): {e.response['Error'].get('Message')}")
        raise
    return result["MessageId"]
