"""ticket-fn unit tests with fake AWS clients (no network). Run from lambdas/ticket-fn: see README."""

import copy
import email
import email.policy
import json
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from botocore.exceptions import ClientError  # noqa: E402

import lambda_function as fn  # noqa: E402
from ticket_pdf import format_start, render_tickets  # noqa: E402

ORDER_CONFIRMED = {
    "type": "OrderConfirmed",
    "version": 1,
    "occurredAt": "2026-10-31T08:00:00.000Z",
    "orderId": "5b0c1e9a-1111-4222-8333-944455556666",
    "holdId": "hold-1",
    "fanId": "c1a2b3c4-sub",
    "concert": {
        "id": "concert-1",
        "title": "TicketMastery Demo Night",
        "artist": "The Cloud Natives",
        "venueName": "Singapore Indoor Stadium",
        "startsAt": "2026-12-23T11:40:00.000Z",
    },
    "currency": "SGD",
    "seats": [
        {"seatId": "seat-a1", "section": "Floor", "row": "A", "seatNumber": "1", "ticketType": "VIP", "priceCents": 12800},
        {"seatId": "seat-a2", "section": "Floor", "row": "A", "seatNumber": "2", "ticketType": "VIP", "priceCents": 12800},
    ],
    "subtotalCents": 25600,
    "bookingFeeCents": 800,
    "totalCents": 26400,
}

CONCERT_CANCELLED = {
    "type": "ConcertCancelled",
    "version": 1,
    "occurredAt": "2026-11-01T08:00:00.000Z",
    "orderId": ORDER_CONFIRMED["orderId"],
    "fanId": ORDER_CONFIRMED["fanId"],
    "concert": ORDER_CONFIRMED["concert"],
    "reason": "Artist illness",
    "currency": "SGD",
    "totalCents": 26400,
}


def client_error(code, operation):
    return ClientError({"Error": {"Code": code, "Message": f"{code} message"}}, operation)


class FakeS3:
    def __init__(self):
        self.objects = {}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[Key] = Body

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise client_error("404", "HeadObject")
        return {}


class FakeSES:
    def __init__(self, error=None):
        self.sent = []
        self.error = error

    def send_raw_email(self, Source, Destinations, RawMessage):
        if self.error:
            raise self.error
        self.sent.append({"source": Source, "to": Destinations, "mail": email.message_from_bytes(RawMessage["Data"], policy=email.policy.default)})
        return {"MessageId": f"ses-{len(self.sent)}"}


class FakeCognito:
    def __init__(self, users):
        self.users = users

    def admin_get_user(self, UserPoolId, Username):
        if Username not in self.users:
            raise client_error("UserNotFoundException", "AdminGetUser")
        return {"Username": Username, "UserAttributes": [{"Name": "sub", "Value": Username}, {"Name": "email", "Value": self.users[Username]}]}


def sqs_event(*messages):
    return {"Records": [{"messageId": f"m{i}", "body": json.dumps(m)} for i, m in enumerate(messages)]}


class TicketFnTest(unittest.TestCase):
    def setUp(self):
        self.s3 = FakeS3()
        self.ses = FakeSES()
        self.cognito = FakeCognito({ORDER_CONFIRMED["fanId"]: "fan@example.com"})
        fn._clients.clear()
        fn._clients.update({"s3": self.s3, "ses": self.ses, "cognito-idp": self.cognito})
        patcher = mock.patch.dict(
            os.environ,
            {"TICKET_BUCKET": "tickets", "SENDER_EMAIL": "sender@example.com", "USER_POOL_ID": "pool", "FALLBACK_RECIPIENT_EMAIL": ""},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(fn._clients.clear)

    def test_order_confirmed_stores_pdf_and_emails_it(self):
        result = fn.lambda_handler(sqs_event(ORDER_CONFIRMED), None)

        self.assertEqual(result, {"batchItemFailures": []})
        order_id = ORDER_CONFIRMED["orderId"]
        pdf = self.s3.objects[f"tickets/{order_id}.pdf"]
        self.assertTrue(pdf.startswith(b"%PDF-1.4"))
        marker = json.loads(self.s3.objects[f"sent/order-confirmed/{order_id}.json"])
        self.assertEqual(marker["sesMessageId"], "ses-1")

        (sent,) = self.ses.sent
        self.assertEqual(sent["to"], ["fan@example.com"])
        mail = sent["mail"]
        self.assertEqual(mail["Subject"], "Your 2 tickets for TicketMastery Demo Night")
        self.assertIn("sender@example.com", mail["From"])
        text, attachment = [part for part in mail.walk() if not part.is_multipart()]
        self.assertIn("Floor, Row A, Seat 2 (VIP)", text.get_content())
        self.assertIn("Total paid: SGD 264.00", text.get_content())
        self.assertEqual(attachment.get_filename(), "tickets-5b0c1e9a.pdf")
        self.assertEqual(attachment.get_payload(decode=True), pdf)

    def test_repeat_delivery_sends_once(self):
        fn.lambda_handler(sqs_event(ORDER_CONFIRMED), None)
        result = fn.lambda_handler(sqs_event(ORDER_CONFIRMED, ORDER_CONFIRMED), None)

        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(len(self.ses.sent), 1)

    def test_concert_cancelled_emails_the_fan(self):
        result = fn.lambda_handler(sqs_event(CONCERT_CANCELLED, CONCERT_CANCELLED), None)

        self.assertEqual(result, {"batchItemFailures": []})
        (sent,) = self.ses.sent
        mail = sent["mail"]
        self.assertEqual(mail["Subject"], "Cancelled: TicketMastery Demo Night")
        body = mail.get_content()
        self.assertIn("Reason: Artist illness", body)
        self.assertIn("refunded SGD 264.00", body)
        self.assertIn(f"sent/concert-cancelled/{CONCERT_CANCELLED['orderId']}.json", self.s3.objects)

    def test_cancellation_is_sent_even_after_the_tickets(self):
        fn.lambda_handler(sqs_event(ORDER_CONFIRMED, CONCERT_CANCELLED), None)

        self.assertEqual([s["mail"]["Subject"].split(":")[0] for s in self.ses.sent], ["Your 2 tickets for TicketMastery Demo Night", "Cancelled"])

    def test_unknown_event_type_is_skipped(self):
        result = fn.lambda_handler(sqs_event({"type": "SomethingElse", "orderId": "x"}), None)

        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(self.ses.sent, [])

    def test_only_the_failing_message_is_retried(self):
        bad = {**ORDER_CONFIRMED, "orderId": "other-order", "fanId": "nobody"}
        result = fn.lambda_handler(sqs_event(bad, ORDER_CONFIRMED, "not an object"), None)

        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "m0"}, {"itemIdentifier": "m2"}]})
        self.assertEqual(len(self.ses.sent), 1)
        self.assertNotIn("sent/order-confirmed/other-order.json", self.s3.objects)

    def test_malformed_json_is_retried(self):
        event = {"Records": [{"messageId": "m0", "body": "{not json"}]}

        self.assertEqual(fn.lambda_handler(event, None), {"batchItemFailures": [{"itemIdentifier": "m0"}]})

    def test_fallback_recipient_for_dev_header_fan_ids(self):
        os.environ["FALLBACK_RECIPIENT_EMAIL"] = "me@example.com"
        fn.lambda_handler(sqs_event({**ORDER_CONFIRMED, "fanId": "fan-1"}), None)

        self.assertEqual(self.ses.sent[0]["to"], ["me@example.com"])

    def test_fallback_when_no_user_pool_is_configured(self):
        os.environ.update({"USER_POOL_ID": "", "FALLBACK_RECIPIENT_EMAIL": "me@example.com"})
        fn.lambda_handler(sqs_event(ORDER_CONFIRMED), None)

        self.assertEqual(self.ses.sent[0]["to"], ["me@example.com"])

    def test_ses_rejection_is_retried_and_not_marked_sent(self):
        self.ses.error = client_error("MessageRejected", "SendRawEmail")
        with mock.patch("builtins.print") as printed:
            result = fn.lambda_handler(sqs_event(ORDER_CONFIRMED), None)

        self.assertEqual(result, {"batchItemFailures": [{"itemIdentifier": "m0"}]})
        self.assertNotIn(f"sent/order-confirmed/{ORDER_CONFIRMED['orderId']}.json", self.s3.objects)
        self.assertTrue(any("SES REJECTED" in str(c.args[0]) for c in printed.call_args_list))

    def test_missing_sender_fails_clearly(self):
        os.environ["SENDER_EMAIL"] = ""
        with mock.patch("builtins.print") as printed:
            result = fn.lambda_handler(sqs_event(ORDER_CONFIRMED), None)

        self.assertEqual(len(result["batchItemFailures"]), 1)
        self.assertIn("SENDER_EMAIL is not set", printed.call_args_list[-1].args[0])


class TicketPdfTest(unittest.TestCase):
    def test_start_time_is_shown_in_singapore_time(self):
        self.assertEqual(format_start("2026-12-23T11:40:00.000Z"), "Wed 23 Dec 2026, 7:40 PM SGT")
        self.assertEqual(format_start("2026-12-23T16:05:00Z"), "Thu 24 Dec 2026, 12:05 AM SGT")

    def test_pdf_has_a_summary_and_one_page_per_seat_with_a_valid_xref(self):
        pdf = render_tickets(ORDER_CONFIRMED)

        self.assertIn(b"/Count 3", pdf)
        self.assertTrue(pdf.endswith(b"%%EOF\n"))
        xref_at = int(re.search(rb"startxref\n(\d+)\n", pdf).group(1))
        self.assertTrue(pdf[xref_at:].startswith(b"xref\n"))
        offsets = [int(o) for o in re.findall(rb"(\d{10}) 00000 n ", pdf)]
        for number, offset in enumerate(offsets, start=1):
            self.assertTrue(pdf[offset:].startswith(b"%d 0 obj" % number), f"object {number} offset")

    def test_rendering_is_deterministic(self):
        self.assertEqual(render_tickets(ORDER_CONFIRMED), render_tickets(copy.deepcopy(ORDER_CONFIRMED)))

    def test_special_characters_do_not_break_the_pdf(self):
        event = copy.deepcopy(ORDER_CONFIRMED)
        event["concert"]["title"] = "Back\\slash (live) — 演唱会 " * 3
        pdf = render_tickets(event)

        self.assertIn(rb"Back\\slash \(live\) ? ??? ", pdf)


if __name__ == "__main__":
    unittest.main()
