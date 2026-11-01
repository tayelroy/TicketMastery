# nfr7-eticket: e-ticket delivery time

Latency = SES accepted the email minus the order's confirmation time (`ticket-fn` logs `deliveryLatencyMs` per order;
CloudWatch Logs Insights over `/aws/lambda/ticketmastery-dev-ticket-fn`, 2026-11-01). Recipients are SES
mailbox-simulator addresses (`success+ltNNN@simulator.amazonses.com`), which the SES sandbox accepts.

## Round 1: 10 orders confirmed 09:31:06–09:31:14 UTC (NFR-3 run 1)

The first attempt for every order failed: the function's IAM policy allowed `ses:SendEmail` but SESv2 authorises a
raw-MIME send as `ses:SendRawEmail` (`AccessDeniedException` in the log). Each message went back to `ticket-queue`;
we fixed the policy (and passed the sender explicitly) and applied at 09:33. When the messages became visible again
after the 360 s visibility timeout, every order was emailed on its second attempt:

| Orders | Emailed | Latency (s) | Messages in `ticket-dlq` |
| --- | --- | --- | --- |
| 10 | 10 | 361–369 | 0 |

So no order was lost; this run shows the retry path (failure F5), not the normal delivery time.

## Round 2: 10 orders confirmed 09:36:05–09:36:12 UTC (NFR-3 run 2, after the fix)

| Orders | Emailed | p50 (s) | p95 (s) | Max (s) | Within 60 s | DLQ |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 10 | 4.4 | 9.9 | 9.9 | 10 (100%) | 0 |

The queue's `ApproximateAgeOfOldestMessage` rose to 359 s at 09:37 and fell to 0 at 09:38: that was round 1's
messages waiting out their visibility timeout, so it doesn't measure round 2.

Per-order latency (s): 2.1, 3.3, 3.4, 3.6, 4.4, 7.2, 7.2, 7.5, 9.3, 9.9. The spread comes from `ticket-fn` running at
most 2 at a time (event-source maximum concurrency 2, sized for the SES sandbox rate of 1 email/s) and a cold start
on the first invocation.

| NFR | Target | Measured (round 2) | Result |
| --- | --- | --- | --- |
| NFR-7 | 95% of e-ticket emails within 60 s of payment | 100% within 60 s; p95 9.9 s | PASS |
