"""Unit tests for queue-manager. Standard library only: boto3 is replaced by an in-memory live-queue table.

Run from lambdas/queue-manager: python3 -m unittest discover -s tests
"""

import io
import json
import os
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path

os.environ.update(TABLE_NAME="live-queue", ADMIT_BATCH_SIZE="3", RECHECK_POSITIONS="2")


class ConditionalCheckFailedException(Exception):
    pass


class FakeTable:
    """Just enough of the boto3 Table API, and of the expression syntax, for what lambda_function sends."""

    def __init__(self):
        self.items = {}
        self.meta = types.SimpleNamespace(
            client=types.SimpleNamespace(
                exceptions=types.SimpleNamespace(ConditionalCheckFailedException=ConditionalCheckFailedException)
            )
        )

    @staticmethod
    def _key(key):
        return (key["eventId"], key["userId"])

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get(self._key(Key))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        key = self._key(Item)
        names = ExpressionAttributeNames or {}
        current = self.items.get(key) or {}
        if ConditionExpression and not self._matches(current, ConditionExpression, lambda n: names.get(n, n),
                                                     ExpressionAttributeValues or {}):
            raise ConditionalCheckFailedException()
        self.items[key] = dict(Item)

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames=None,
                    ConditionExpression=None, ReturnValues=None):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues
        name = lambda n: names.get(n, n)
        current = self.items.get(self._key(Key))
        if ConditionExpression and not self._matches(current or {}, ConditionExpression, name, values):
            raise ConditionalCheckFailedException()
        item = current if current is not None else dict(Key)
        set_part, _, add_part = UpdateExpression.partition(" ADD ")
        for assignment in set_part.removeprefix("SET ").split(", "):
            attr, value = assignment.split(" = ")
            item[name(attr)] = values[value]
        if add_part:
            attr, value = add_part.split(" ")
            item[name(attr)] = item.get(name(attr), 0) + values[value]
        self.items[self._key(Key)] = item
        return {"Attributes": dict(item)}

    @staticmethod
    def _matches(item, expression, name, values):
        for term in expression.split(" OR "):
            if term.startswith("attribute_not_exists("):
                if name(term[len("attribute_not_exists("):-1]) not in item:
                    return True
                continue
            attr, op, value = term.split(" ")
            actual = item.get(name(attr))
            if actual is not None and (actual == values[value] if op == "=" else actual < values[value]):
                return True
        return False

    def query(self, IndexName, KeyConditionExpression, ExpressionAttributeValues, ExpressionAttributeNames=None,
              ScanIndexForward=True, Limit=None, ExclusiveStartKey=None):
        values = ExpressionAttributeValues
        if IndexName == "counter-index":
            rows = [i for i in self.items.values() if i.get("rowType") == values[":counter"]]
            rows.sort(key=lambda i: i["eventId"])
        else:
            assert IndexName == "position-index"
            rows = [i for i in self.items.values()
                    if i["eventId"] == values[":e"] and "position" in i and i["position"] > values[":after"]]
            rows.sort(key=lambda i: i["position"])
        start = ExclusiveStartKey["offset"] if ExclusiveStartKey else 0
        end = start + Limit if Limit else len(rows)
        page = {"Items": [dict(i) for i in rows[start:end]]}
        if end < len(rows):
            page["LastEvaluatedKey"] = {"offset": end}
        return page


sys.modules["boto3"] = types.SimpleNamespace(resource=lambda _name: types.SimpleNamespace(Table=lambda _n: FakeTable()))
sys.dont_write_bytecode = True  # archive_file zips src/, so keep __pycache__ out of it
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import lambda_function as qm  # noqa: E402

NOW = 1_800_000_000
CONCERT = "7b1841b9-a076-4469-8a95-1ea37e01fe03"
OTHER = "c0ffee00-0000-4000-8000-000000000001"


def run_quietly(fn, *args, **kwargs):
    out = io.StringIO()
    with redirect_stdout(out):
        result = fn(*args, **kwargs)
    return result, out.getvalue()


class QueueManagerTest(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        qm.table = self.table

    def join(self, event_id, *users, **sale):
        for user in users:
            run_quietly(qm.assign_position, {"eventId": event_id, "userId": user, "joinedAt": NOW - 60, **sale})

    def row(self, event_id, user):
        return self.table.items[(event_id, user)]

    def counter(self, event_id):
        return self.table.items[(event_id, qm.COUNTER)]

    def statuses(self, event_id):
        rows = [i for i in self.table.items.values() if i["eventId"] == event_id and "position" in i]
        return [i["status"] for i in sorted(rows, key=lambda i: i["position"])]


class AssignPositionTest(QueueManagerTest):
    def test_counter_is_listed_in_counter_index_with_the_sale_window(self):
        self.join(CONCERT, "fan-1", "fan-2", saleStartsAt=NOW - 10, saleEndsAt=NOW + 3600)
        counter = self.counter(CONCERT)
        self.assertEqual(counter["rowType"], "COUNTER")
        self.assertEqual((counter["saleStartsAt"], counter["saleEndsAt"]), (NOW - 10, NOW + 3600))
        self.assertEqual(counter["lastPosition"], 2)
        self.assertEqual((self.row(CONCERT, "fan-2")["position"], self.row(CONCERT, "fan-2")["status"]), (2, "WAITING"))

    def test_join_without_sale_window_still_assigns(self):
        self.join(CONCERT, "fan-1")
        self.assertNotIn("saleStartsAt", self.counter(CONCERT))
        self.assertEqual(self.row(CONCERT, "fan-1")["position"], 1)

    def test_duplicate_join_keeps_place_while_waiting_or_admitted(self):
        self.join(CONCERT, "fan-1", "fan-2")
        self.row(CONCERT, "fan-2").update(status="ADMITTED", admissionExpiresAt=4_000_000_000)
        self.join(CONCERT, "fan-1", "fan-2")
        self.assertEqual([self.row(CONCERT, f)["position"] for f in ("fan-1", "fan-2")], [1, 2])
        self.assertEqual(self.counter(CONCERT)["lastPosition"], 2)

    def test_rejoins_at_the_back_once_admission_ran_out(self):
        self.join(CONCERT, "fan-1", "fan-2", "fan-3")
        self.row(CONCERT, "fan-1").update(status="ADMITTED", admissionExpiresAt=1)
        self.row(CONCERT, "fan-2")["status"] = "EXPIRED"
        self.join(CONCERT, "fan-1", "fan-2")
        self.assertEqual((self.row(CONCERT, "fan-1")["position"], self.row(CONCERT, "fan-1")["status"]), (4, "WAITING"))
        self.assertEqual(self.row(CONCERT, "fan-2")["position"], 5)
        self.assertNotIn("admissionExpiresAt", self.row(CONCERT, "fan-1"))

    def test_sqs_batch_path_unchanged(self):
        records = [{"messageId": f"m{i}", "body": json.dumps({"eventId": CONCERT, "userId": f"fan-{i}"})}
                   for i in range(2)]
        result, _ = run_quietly(qm.lambda_handler, {"Records": records}, None)
        self.assertEqual(result, {"batchItemFailures": []})
        self.assertEqual(self.statuses(CONCERT), ["WAITING", "WAITING"])


class AdmitTest(QueueManagerTest):
    def test_admits_next_batch_in_position_order_with_15_minute_expiry(self):
        self.join(CONCERT, *[f"fan-{i}" for i in range(1, 6)])
        result, _ = run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(result, {"status": "ok", "admitted": 3, "waiting": 2})
        self.assertEqual(self.statuses(CONCERT), ["ADMITTED"] * 3 + ["WAITING"] * 2)
        self.assertEqual(self.row(CONCERT, "fan-1")["admissionExpiresAt"], NOW + 900)
        self.assertEqual(self.counter(CONCERT)["admittedUpTo"], 3)

        result, _ = run_quietly(qm.admit_all, now=NOW + 60)
        self.assertEqual(result["admitted"], 2)
        self.assertEqual(self.statuses(CONCERT), ["ADMITTED"] * 5)
        self.assertEqual(self.counter(CONCERT)["admittedUpTo"], 5)
        self.assertEqual(self.row(CONCERT, "fan-1")["admissionExpiresAt"], NOW + 900, "already admitted: unchanged")

    def test_each_concert_gets_its_own_batch(self):
        self.join(CONCERT, "a1", "a2", "a3", "a4")
        self.join(OTHER, "b1", "b2")
        result, _ = run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(result, {"status": "ok", "admitted": 5, "waiting": 1})

    def test_skips_rows_that_are_not_waiting(self):
        self.join(CONCERT, "fan-1", "fan-2", "fan-3", "fan-4")
        self.row(CONCERT, "fan-2")["status"] = "EXPIRED"
        run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(self.statuses(CONCERT), ["ADMITTED", "EXPIRED", "ADMITTED", "ADMITTED"])
        self.assertEqual(self.counter(CONCERT)["admittedUpTo"], 4)

    def test_keeps_the_row_alive_while_admitted(self):
        self.join(CONCERT, "fan-1")
        self.row(CONCERT, "fan-1")["expiresAt"] = NOW + 10
        run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(self.row(CONCERT, "fan-1")["expiresAt"], NOW + 900)

    def test_admits_straggler_missed_by_the_index(self):
        self.join(CONCERT, "fan-1", "fan-2", "fan-3")
        self.counter(CONCERT)["admittedUpTo"] = 3  # an earlier run moved past fan-3 before it was indexed
        run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(self.statuses(CONCERT), ["WAITING", "ADMITTED", "ADMITTED"], "looks back 2 places")
        self.assertEqual(self.counter(CONCERT)["admittedUpTo"], 3)

    def test_nothing_admitted_outside_the_sale_window(self):
        self.join(CONCERT, "early", saleStartsAt=NOW + 60, saleEndsAt=NOW + 3600)
        self.join(OTHER, "late", saleStartsAt=NOW - 3600, saleEndsAt=NOW)
        result, _ = run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(result, {"status": "ok", "admitted": 0, "waiting": 2})
        result, _ = run_quietly(qm.admit_all, now=NOW + 60)
        self.assertEqual(self.row(CONCERT, "early")["status"], "ADMITTED")
        self.assertEqual(self.row(OTHER, "late")["status"], "WAITING")

    def test_scheduler_event_runs_admit_and_emits_waiting_room_size(self):
        self.join(CONCERT, *[f"fan-{i}" for i in range(1, 5)])
        result, out = run_quietly(qm.lambda_handler, {"source": "scheduler"}, None)
        self.assertEqual(result["admitted"], 3)
        emf = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
        self.assertEqual(len(emf), 1)
        self.assertEqual(emf[0]["WaitingRoomSize"], 1)
        directive = emf[0]["_aws"]["CloudWatchMetrics"][0]
        self.assertEqual(directive["Namespace"], "TicketMastery")
        self.assertEqual(directive["Dimensions"], [[]])
        self.assertEqual(directive["Metrics"], [{"Name": "WaitingRoomSize", "Unit": "Count"}])

    def test_empty_queue_still_emits_zero(self):
        result, out = run_quietly(qm.admit_all, now=NOW)
        self.assertEqual(result, {"status": "ok", "admitted": 0, "waiting": 0})
        self.assertIn('"WaitingRoomSize": 0', out)

    def test_one_failing_concert_does_not_stop_the_others(self):
        self.join(CONCERT, "a1")
        self.join(OTHER, "b1")
        real_get = self.table.get_item

        def get_item(Key, ConsistentRead=False):
            if Key["eventId"] == CONCERT:
                raise RuntimeError("throttled")
            return real_get(Key, ConsistentRead)

        self.table.get_item = get_item
        with self.assertRaises(RuntimeError), redirect_stdout(io.StringIO()):
            qm.admit_all(now=NOW)
        self.assertEqual(self.row(OTHER, "b1")["status"], "ADMITTED")


if __name__ == "__main__":
    unittest.main()
