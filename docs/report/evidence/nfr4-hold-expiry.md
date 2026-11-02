# nfr4-hold-expiry (2026-10-31T16:29:11.131Z to 2026-10-31T16:39:47.518Z)

Target: `https://veft7waoye.execute-api.ap-southeast-1.amazonaws.com` (AUTH=cognito)

| Seat | Hold expires at | Seat map 20 s before | Available again at | Seconds after expiry | Fan B re-hold | Fan A late payment | NFR-4 (≤ 30 s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R20-1000 | 2026-10-31T16:39:46.848Z | held | 2026-10-31T16:39:47.432Z | 0.6 | HTTP 201 at +0.6 s | HTTP 409 hold_expired | PASS |

Concert `16e33f9e-ee2f-4e64-8e37-410b644dbf5b`, seat map polled every 2 s (so the measured delay is accurate to about 2 s).
