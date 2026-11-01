# nfr3-oversell (2026-11-01T09:30:51.172Z to 2026-11-01T09:31:18.572Z)

Target: `https://veft7waoye.execute-api.ap-southeast-1.amazonaws.com` (AUTH=cognito)

| Fans | Contested seats | Hold attempts | Successful holds | Lost races (409) | Paid orders | Seats paid for | Payment failures | Pool seats sold (seat map) | Oversold (API view) | 5xx |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 20 | 147 | 10 | 137 | 10 | 20 | 0 | 20 | 0 | 0 |

Concert `40bbf5af-51a8-4357-95ca-bbe13b3de741`. API-level result: PASS. Confirm with the SQL check: `scripts/nfr3-oversell-check.sh 40bbf5af-51a8-4357-95ca-bbe13b3de741`.

# nfr3-oversell-sql (2026-11-01T09:31:27.695Z)

Scope: concert 40bbf5af-51a8-4357-95ca-bbe13b3de741, database ticketmastery-dev-postgres.c1qo8mkcolsu.ap-southeast-1.rds.amazonaws.com/ticketmastery (TARGET=aws)

| Confirmed orders | Seats in confirmed orders | Seats with status sold | Seats in 2+ confirmed orders | Sold seat without a confirmed order | Confirmed seat not sold to its order | NFR-3 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 20 | 20 | 0 | 0 | 0 | PASS |

# nfr3-oversell-sql (2026-11-01T09:31:32.700Z)

Scope: all concerts, database ticketmastery-dev-postgres.c1qo8mkcolsu.ap-southeast-1.rds.amazonaws.com/ticketmastery (TARGET=aws)

| Confirmed orders | Seats in confirmed orders | Seats with status sold | Seats in 2+ confirmed orders | Sold seat without a confirmed order | Confirmed seat not sold to its order | NFR-3 |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 20 | 20 | 0 | 0 | 0 | PASS |
