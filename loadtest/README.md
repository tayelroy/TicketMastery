# loadtest: NFR evidence

Repeatable tests for the non-functional requirements in `docs/report/report.md` section 2.5, producing the numbers for
section 10. k6 drives the API; shell scripts collect AWS-side evidence (CloudWatch, ECS, RDS) read-only, except the
two drills (F1 stops the API task, F4 restores RDS to a new instance and deletes it).

| NFR | Target | Script | Output |
|---|---|---|---|
| NFR-1 | browse p95 < 300 ms, p99 < 800 ms at baseline | `k6/nfr1-browse.js` + `scripts/alb-metrics.sh` | `results/nfr1-browse-*`, `results/nfr1-alb-*` |
| NFR-2 | 10× burst, scale-out ≤ 5 min, 0 dropped | `scripts/nfr2-burst.sh` (runs `k6/nfr2-burst.js`) | `results/nfr2-burst-*`, `nfr2-burst-aws-*` (+ `-ecs.csv`), `nfr2-alb-*` |
| NFR-3 | no seat sold twice | `k6/nfr3-oversell.js` + `scripts/nfr3-oversell-check.sh` | `results/nfr3-oversell-*`, `nfr3-oversell-sql-*` |
| NFR-4 | seat available ≤ 30 s after hold expiry | `k6/nfr4-hold-expiry.js` | `results/nfr4-hold-expiry-*` |
| NFR-5 | F1: task loss, RTO ≤ 5 min | `scripts/nfr5-f1-task-loss.sh` | `results/nfr5-f1-*` (+ `.csv` probe log) |
| NFR-6 | admission in arrival order | `k6/nfr6-waiting-room.js` | `results/nfr6-waiting-room-*` |
| NFR-7 | 95% of e-tickets within 60 s | `scripts/nfr7-eticket.sh` | `results/nfr7-eticket-*` |
| NFR-8/9 | F4: PITR, RPO ≤ 30 min, RTO ≤ 1 h | `scripts/nfr8-f4-pitr.sh` | `results/nfr8-f4-pitr-*` |
| NFR-10 | HTTPS, encryption at rest, private DB | `scripts/nfr10-config.sh` | `results/nfr10-config-*` |
| All of the above together | a whole on-sale: queue, admission, contention, payment, e-tickets, scaling | `scripts/flash-sale.sh` (runs `k6/flash-sale.js`) | `results/flash-sale-*` (+ `-fans.log`, `-ecs.csv`), `flash-sale-k6-*` |

Each run writes `results/<test>-<UTC timestamp>.json` and a `.md` table to paste into the report
(see [`results/README.md`](results/README.md)).

## Layout

```
k6/lib/config.js       BASE_URL, AUTH (dev | cognito), fans/organiser, CONCERT_ID
k6/lib/api.js          organiser concert setup, seat map, waiting-room admission
k6/lib/browse.js       browse request mix (NFR-1, NFR-2)
k6/lib/summary.js      results/<test>-<ts>.json + .md
k6/*.js                setup-concert, nfr1, nfr2, nfr3, nfr4, nfr6
scripts/lib.sh         AWS profile/account guard, resource names (ticketmastery-dev-*), DRY_RUN
scripts/*.sh           Cognito users, metrics, drills, checks
sql/oversell-check.js  NFR-3 SQL, run inside the API container (ECS Exec) or locally
sql/reporting-role.js  sets or removes reporting_ro's login, run inside the API container by scripts/reporting-user.sh
dev/fake-waiting-room.mjs  local dry runs only: the waiting room's contract in memory, proxying the rest
state/                 gitignored: tokens.json, users.json, lt-password, concert.json
```

Requirements: k6 ≥ 1.0 (tested with 2.3), AWS CLI v2, `jq`, `session-manager-plugin` (ECS Exec), Node 20+ and
`npm ci` in `services/ticketmastery-api` (local SQL check only). Run everything from this folder.

## Settings

| Variable | Default | Used by |
|---|---|---|
| `BASE_URL` | k6: `http://localhost:3000`; scripts: the API Gateway URL | all |
| `AUTH` | `dev` | k6: `dev` sends `x-dev-user-*` headers, `cognito` sends `Bearer` tokens from `state/tokens.json` |
| `CONCERT_ID` | from `state/concert.json` | nfr1, nfr2, nfr3, nfr4 |
| `FANS`, `FAN_OFFSET` | per script | which fans (index into `tokens.json`) a test uses |
| `TM_AWS_PROFILE` | `ticketmastery-tf` | scripts pin this profile (your shell's `AWS_PROFILE` is ignored) and refuse any account but `000246635159` |
| `DRY_RUN=1` | off | scripts print the changing AWS calls instead of making them |

Use the **API Gateway URL** (`terraform -chdir=infra/envs/dev output -raw api_endpoint`) as `BASE_URL`, not
CloudFront: the CloudFront WAF allows 2,000 requests per 5 minutes per IP (≈ 6.7 req/s), so browse tests through
CloudFront are blocked within minutes (the k6 scripts print a warning and count the `403`s; that only shows the WAF
working). API Gateway itself throttles the stage at 100 req/s (burst 200), so the 10× burst (100 req/s) sits on
that limit and the excess is answered with `429`, which NFR-2 counts apart from real failures.

k6 measures from your machine, so its latency includes the network path to ap-southeast-1; the ALB's
`TargetResponseTime` (`scripts/alb-metrics.sh`) is the server-side share. Run from Singapore if you can.

## Dry run locally (dev auth)

```bash
cd services/ticketmastery-api && docker compose up --build -d && cd ../../loadtest
export BASE_URL=http://localhost:3000 AUTH=dev

k6 run k6/setup-concert.js                                   # SEATS=500, SALE_OPENS_IN=30
RATE=5 DURATION=20s k6 run k6/nfr1-browse.js
BASE_RPS=3 MULT=10 WARM=20s RAMP=10s HOLD=40s COOL=20s k6 run k6/nfr2-burst.js
FANS=20 POOL=8 START_DELAY=2 k6 run k6/nfr3-oversell.js
TARGET=local scripts/nfr3-oversell-check.sh "$(jq -r .concertId state/concert.json)"
TARGET=local STOP_CMD="docker stop ticketmastery-api-1 && sleep 8 && docker start ticketmastery-api-1" STABLE=5 \
  scripts/nfr5-f1-task-loss.sh
TARGET=local BASE_RPS=2 MULT=5 WARM=10s RAMP=5s HOLD=15s COOL=10s scripts/nfr2-burst.sh   # k6 only

# The local API has no waiting room (501), so NFR-6 and the admission step use the in-memory stand-in on :3200:
UPSTREAM=http://localhost:3000 ADMIT_EVERY_MS=4000 ADMIT_BATCH=3 node dev/fake-waiting-room.mjs &
BASE_URL=http://localhost:3200 FANS=8 SALE_OPENS_IN=6 POLL=2 TIMEOUT=60 k6 run k6/nfr6-waiting-room.js
BASE_URL=http://localhost:3200 FAN_OFFSET=100 k6 run k6/nfr4-hold-expiry.js     # ~11 min (10-minute hold)

DRY_RUN=1 scripts/cognito-users.sh create 3      # read-only AWS lookups, prints the admin-* calls
DRY_RUN=1 NO_OUTAGE_WAIT=3 scripts/nfr5-f1-task-loss.sh   # prints stop-task, polls /health 3 s
DRY_RUN=1 scripts/nfr8-f4-pitr.sh                # prints the restore point and the restore/delete calls
AUTH=dev scripts/cancel-loadtest-concerts.sh     # cancels the local load-test concerts
```

`docker compose down -v` afterwards wipes the local database.

## Run against AWS (in this order)

Before: the new API image is deployed, `/health` is 200 through API Gateway, the admit schedule is enabled, and ECS
Exec is on (`enable_execute_command = true`, which also gives the task role `ssmmessages:*`; the service must have
started a task since). Note the start and end time of every step (the result files record them).

```bash
cd loadtest
export AUTH=cognito BASE_URL="$(terraform -chdir=../infra/envs/dev output -raw api_endpoint)"
```

**1. Test users** (≈ 1 min). 100 race fans (#0–99), 2 for NFR-4 (#100–101), 20 for NFR-6 (#102–121).

```bash
scripts/cognito-users.sh create 125
scripts/cognito-users.sh tokens        # access tokens last 60 min: rerun before any step started later than that
```

Expect `created success+lt001@simulator.amazonses.com (fan)` … and `125 fan tokens + organiser in …/state/tokens.json`.

**2. NFR-10 configuration** (read-only, any time): `scripts/nfr10-config.sh`. Expect every row `yes` and
`NFR-10: PASS`. Screenshot: RDS → Connectivity & security (Publicly accessible: No) and Configuration (Encryption:
Enabled); CloudFront → Behaviors (Redirect HTTP to HTTPS).

**3. Load-test concert, fans 0–99 admitted** (≈ 2–3 min; the admit step runs once a minute after the sale opens).

```bash
SEATS=1000 SALE_OPENS_IN=30 ADMIT_FANS=100 k6 run k6/setup-concert.js
```

Expect `waiting room: all 100 fans admitted after …s` and `state/concert.json`. Their admission lasts 15 minutes:
do step 4 straight away (the k6 script refuses to start with less than 5 minutes left; then wait for the admissions
to expire and rerun step 4, which rejoins them).

**4. NFR-3 race + SQL check** (≈ 1 min), then the e-tickets for NFR-7 are on their way.

```bash
FANS=100 POOL=20 SEATS_PER_HOLD=2 PAY_FAIL_RATE=0.1 k6 run k6/nfr3-oversell.js
scripts/nfr3-oversell-check.sh "$(jq -r .concertId state/concert.json)"    # this concert
scripts/nfr3-oversell-check.sh                                             # every concert in RDS
```

Expect many `Lost races (409)`, `Oversold (API view) 0`, then from the ECS task
`OVERSELL_CHECK_RESULT {…"seats_in_two_confirmed_orders":0…"pass":true}` and an `NFR-3 PASS` row (rerun the
all-concerts check at the very end, after every test). Screenshot: the terminal with the SQL result.

**5. NFR-4 hold expiry** (≈ 12 min; can run in a second terminal while you do step 6).

```bash
FAN_OFFSET=100 k6 run k6/nfr4-hold-expiry.js
```

Expect `Seat map 20 s before: held`, `Seconds after expiry` a few seconds (the poll interval), `Fan B re-hold HTTP
201`, `Fan A late payment HTTP 409 hold_expired`, `PASS`.

**6. NFR-6 waiting-room order** (≈ 4 min: 2 min until the sale opens, then the next admit run).

```bash
FANS=20 FAN_OFFSET=102 SALE_OPENS_IN=120 k6 run k6/nfr6-waiting-room.js
```

Expect positions 1–20 in join order, `Position inversions 0`, `Admission-order inversions 0`, `PASS`. With the
default batch of 500 all 20 fans are admitted by the same run; the evidence is then "queue position = arrival
order" plus "nobody admitted ahead of an earlier fan". To see several admit runs, the admit batch has to be smaller
than 20: plan and apply with `-var admit_batch_size=5` (it changes only the queue-manager environment and the
schedule description), run the test, then plan/apply without it to restore 500.
Screenshot: CloudWatch Logs for `queue-manager` (`ASSIGNED … -> #n` lines and `ADMIT RUN admitted=…`).

**7. NFR-7 e-ticket delay** (read-only; 5 minutes after step 4):

```bash
scripts/nfr7-eticket.sh "$(jq -r .startedAt "$(ls -t results/nfr3-oversell-2*.json | head -1)")" "$(date -u +%FT%TZ)"
```

Expect `E-tickets sent` = paid orders from step 4, `Within 60 s` ≈ 100%, a small `Max SQS age`, DLQ 0, `PASS`.
Screenshots: SQS `ticketmastery-dev-ticket-queue` → Monitoring (Approximate age of oldest message); the Logs Insights
query from the script on `/aws/lambda/ticketmastery-dev-ticket-fn`; SES → Account dashboard (sends / deliveries).

**8. NFR-1 browse at baseline** (≈ 6 min), then the ALB view of the same window (wait 2 minutes for the metrics):

```bash
RATE=10 DURATION=5m k6 run k6/nfr1-browse.js
scripts/alb-metrics.sh nfr1 $(jq -r '.startedAt, .finishedAt' "$(ls -t results/nfr1-browse-*.json | head -1)")
```

Expect p95 / p99 and `PASS` or `FAIL` against 300 / 800 ms, then the ALB p95/p99 per minute. Screenshot: CloudWatch
metric ALB `TargetResponseTime` (p95, 1-minute period) over the window.

**9. NFR-2 burst** (≈ 21 min). Switch autoscaling on first, without editing `terraform.tfvars`:
`terraform -chdir=../infra/envs/dev plan -out=/tmp/as.tfplan -var enable_autoscaling=true -var autoscaling_max_capacity=3`;
apply only if the plan touches just the scalable target, the two scaling policies, the service's desired count and
the monitoring scaling-ceiling alarm.

```bash
BASE_RPS=10 MULT=10 WARM=2m RAMP=1m HOLD=10m COOL=3m scripts/nfr2-burst.sh
```

Expect the k6 table (peak minute ≈ 100 req/s, `429 (throttled)` count, `Dropped (non-429 errors)` 0), then
`Tasks before 1`, `Max tasks` 2–3 with the minutes after the ramp started, the task count every 15 s, the
scaling activities and ECS events. Screenshots while it runs: the `ticketmastery-dev` CloudWatch dashboard (whole
burst), ECS → service → Events and Tasks tabs, any alarm emails. Afterwards plan/apply again without the `-var`
flags (the plan must only remove those resources); the count returns to 1.

**10. NFR-5 / F1 task loss** (≈ 3–5 min; with autoscaling off, so one task):

```bash
scripts/nfr5-f1-task-loss.sh
```

Expect `/health -> 503` or `000` a few seconds after the stop, `200` again when the replacement passes the ALB health
check, `Outage (s)` and `PASS` if ≤ 300 s, plus the ECS events (stopped / started / registered target).
Screenshots: ECS service Events; ALB target group `HealthyHostCount`; the unhealthy-host alarm email.

**11. NFR-8/9 / F4 point-in-time restore** (≈ 15–30 min; creates and deletes a db.t4g.micro):

```bash
DRY_RUN=1 scripts/nfr8-f4-pitr.sh      # check the restore point and the calls first
VERIFY=1 scripts/nfr8-f4-pitr.sh       # VERIFY=1 also runs the NFR-3 SQL check on the restored copy
```

Expect `restore point <LatestRestorableTime> = Ns before now`, status lines (`creating` … `available`), the restore
duration, `deleting ticketmastery-dev-postgres-f4-…`, `PASS`. If the script is killed after the restore starts, its
exit trap deletes the instance; check `aws rds describe-db-instances` afterwards anyway. Screenshot: RDS → Databases
during the restore (the new instance `creating`) and RDS → Events.

**12. Clean up**

```bash
scripts/nfr3-oversell-check.sh          # final all-concerts check
scripts/cancel-loadtest-concerts.sh     # removes the load-test concerts from the listing
scripts/cognito-users.sh cleanup        # deletes success+lt*@simulator.amazonses.com users and state/
```

## Flash-sale simulation

One script runs a whole on-sale against dev and writes one report (plan, profiles and pass criteria:
[`docs/plans/flash-sale-simulation.md`](../docs/plans/flash-sale-simulation.md)). It creates its own users and
concert, so it never touches the demo concert.

```bash
PROFILE=smoke scripts/flash-sale.sh                 # 40 fans, 30 seats, ≈ 8 min
PROFILE=standard CLEANUP=1 scripts/flash-sale.sh    # 400 fans, 300 seats: the evidence run
PROFILE=peak BACKOFF=1 scripts/flash-sale.sh        # 999 fans: over the 100 req/s throttle, with 429 backoff
```

The report (`results/flash-sale-<ts>.md`) has the pass checks (oversell SQL, capacity, outcomes, fair admission, 5xx,
DB connections), fan outcomes and timings, 429s, max tasks per service, waiting-room peak, RDS peak, e-tickets and
the alarms that fired. `CLEANUP=1` cancels the concert and deletes the test users afterwards.

## Notes

- `scripts/nfr3-oversell-check.sh` runs the query in the API container:
  `aws ecs execute-command --cluster ticketmastery-dev-cluster --task <task> --container ticketmastery-api --interactive
  --command "sh -c 'cd /app && echo <gzip+base64 of sql/oversell-check.js> | base64 -d | gunzip | CONCERT_ID=<id> node -'"`.
  The script reads the DB settings from the task's environment (`DB_HOST`, `DB_NAME`, `DB_SSL` from the task
  definition; `DB_USER` / `DB_PASSWORD` injected from the RDS-managed secret) and uses the image's `pg` package.
- The F4 restore keeps the master user and password of the restore point; `VERIFY=1` uses the task's current
  credentials, so it only works if the RDS-managed secret hasn't rotated since.
- `scripts/reporting-user.sh` (not a load test; deploy step, see `docs/deploy.md`) gives the read-only `reporting_ro`
  role a new random password and writes it to the `ticketmastery-dev/reporting/reporting-ro` secret that the
  reporting ECS service logs in with, then forces a new deployment of that service. Same ECS Exec mechanism as the
  oversell check, in an organiser task (master user; `SERVICE_KEY=reporting` is refused). Only a SCRAM-SHA-256
  verifier crosses ECS Exec; the password exists only in a mode-600 `mktemp` file, removed on exit, that
  `put-secret-value` reads with `file://`. `disable` sets the role back to `NOLOGIN` (the reporting service then fails
  its health check); `DRY_RUN=1` prints the calls.
- The stage throttle (100 req/s) and the WAF apply to everyone: don't demo the site while NFR-1/NFR-2 run.
