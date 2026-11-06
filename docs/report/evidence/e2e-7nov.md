# End-to-end pass on the six-service stack (7 Nov 2026, 00:34–00:40 SGT)

One run through every use case on the live dev stack (image `4a443fa`, six ECS services), in a real headless Chromium
browser on `https://d1ubso1416lulu.cloudfront.net`, with throwaway Cognito users (SES mailbox-simulator addresses;
deleted afterwards). Times below are UTC (6 Nov 16:34–16:40 UTC = 7 Nov 00:34–00:40 SGT).

**Test concert:** `2947d57c-…`, created through the organiser API by `loadtest/k6/setup-concert.js` (10 seats, one
ticket type at SGD 50, sale opening 30 s later). Not the demo concert: two seats cost 2 × 50 + 2 × 4 booking fee =
SGD 108.

| Step | Use case / service | Result |
|---|---|---|
| Sign in as a fan | Cognito | "Sign out" shown in the header |
| Concert page | UC1 discovery | "Get tickets" shown |
| Waiting room | UC3 waiting-room | "You're in!" after the next scheduled admit run |
| Select 2 seats → Checkout | UC4 checkout | hold created, "Pay $…" shown |
| Pay (simulated) | UC4 checkout | "Order confirmed", order `6f3f01a4-…` |
| My Tickets → ticket page | UC2 account | "Download e-ticket" shown |
| E-ticket email | ticket-fn → SES | log below: sent 3.4 s after payment |
| PDF download | UC2 account → S3 pre-signed URL | `PDF document, version 1.7` |
| Organiser dashboard | UC5 organiser | "Sold 2 / 10", "Held in checkout 0" |
| Sales reports (last 7 days, this concert) | UC5 reporting (`reporting_ro`) | Gross revenue SGD 108, Tickets sold 2, Orders 1, Average order 108 |
| Cancel the concert | UC5 organiser | `{"status":"cancelled","cancellationNotices":{"orders":1,"published":1}}` |
| Cancellation email | ticket-fn → SES | log below |
| Alarms afterwards | CloudWatch | `describe-alarms`: 31 OK, 0 ALARM, 0 INSUFFICIENT_DATA |

`/aws/lambda/ticketmastery-dev-ticket-fn` (EMF block removed, SES ids shortened):

```
2026-11-06T16:35:53Z {"level":"info","msg":"e-ticket sent","orderId":"6f3f01a4-d9a1-4c26-bafb-b68e2851c3d8",
                      "occurredAt":"2026-11-06T16:35:49.670Z","deliveryLatencyMs":3429,"sesMessageId":"010e01a1b1b77620-…"}
                     {"level":"info","msg":"cancellation notice sent","orderId":"6f3f01a4-d9a1-4c26-bafb-b68e2851c3d8",
                      "concertId":"2947d57c-eb2d-465d-a883-a9abf84158be","sesMessageId":"010e01a1b1b7f7e6-…"}
```

`aws cloudwatch describe-alarms --alarm-name-prefix ticketmastery-dev --query 'MetricAlarms[].StateValue'` at
2026-11-06T16:42:31Z: `31 OK`.
