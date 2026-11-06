# TicketMastery final presentation: slide outline

IS458 final presentation (8%), Tue 10 Nov 2026, 20 minutes. Facts and numbers come from `report.md` and
`docs/report/evidence/` (measured 31 Oct–1 Nov 2026; the per-feature split, reporting service and second burst run
on 6 Nov 2026). The live demo follows `demo-script.md`.

Presenters follow the proposal deck: one use case each (UC1 Cody & Nai Xin, UC2 Andrew, UC3 Yan Ting, UC4 Shi Hui,
UC5 Elroy), and Elroy covers the base infrastructure, monitoring and management approach. The slides added for the
final are shared out so each person speaks for about 2–3 minutes: resource allocation and cost go to Cody (AWS
account and edge owner), linkage and security to Andrew (Cognito and API Gateway owner), scalability to Yan Ting
(waiting room), the evidence slide to Shi Hui (NFR-3 and NFR-4 owner), and limitations to Nai Xin, who also drives
the demo.

Screenshots are in `docs/report/evidence/demo/` (list in `demo-script.md`, section "Fallback assets"); the ones
still marked *to take* need the real inboxes or the AWS console, so take them during the dress rehearsal.

## Timing

| # | Slide | Presenter | Minutes |
|---|---|---|---|
| 1 | TicketMastery: concert ticketing on AWS | Elroy | 0.50 |
| 2 | Business context and requirements | Cody | 0.75 |
| 3 | What changed since the proposal, and why | Elroy | 0.75 |
| 4 | Instructor feedback and our response | Elroy | 0.75 |
| 5 | Architecture: deployed vs target HA | Elroy | 1.00 |
| 6 | Resource allocation and justification | Cody | 0.75 |
| 7 | Linkage of resources | Andrew | 0.75 |
| 8 | UC1 Concert discovery | Cody & Nai Xin | 0.50 |
| 9 | UC2 My Tickets & Account | Andrew | 0.50 |
| 10 | UC3 Virtual waiting room | Yan Ting | 0.75 |
| 11 | UC4 Seat holds, checkout and e-tickets | Shi Hui | 0.75 |
| 12 | UC5 Concert management and reporting | Elroy | 0.50 |
| 13 | Live demo | Nai Xin (driver) + UC owners | 5.50 |
| 14 | Monitoring and alerts | Elroy | 0.75 |
| 15 | Scalability and availability | Yan Ting | 0.75 |
| 16 | Evidence: NFR results | Shi Hui | 0.75 |
| 17 | Management approach: code, pipeline, review | Elroy | 0.75 |
| 18 | Security, backup and DR | Andrew | 0.50 |
| 19 | Cost and Budgets | Cody | 0.50 |
| 20 | Limitations and future work | Nai Xin | 0.50 |
| 21 | Summary and Q&A | Elroy | 0.50 |
| | **Slides + demo** | | **18.75** |
| | Buffer (hand-overs, demo overrun) | | 1.00 |
| | **Total** | | **19.75** |

Per person (slides only, excluding the demo): Elroy 5.25, Cody 2.25 (+ half of slide 8), Andrew 1.75, Yan Ting
1.50, Shi Hui 1.50, Nai Xin 0.50 (+ half of slide 8) + demo driver.

Speaker notes are written for about 130–140 words per minute: 0.50 min ≈ 65–75 words, 0.75 min ≈ 95–105 words,
1.00 min ≈ 115–120 words.

---

## Slide 1. TicketMastery: concert ticketing on AWS

- **Presenter:** Elroy · **Minutes:** 0.50
- **On slide:**
  - Group 4 · IS458 Cloud Management and Engineering · final presentation, 10 Nov 2026
  - Owners: UC1 Discovery Cody & Nai Xin · UC2 My Tickets Andrew · UC3 Waiting room Yan Ting · UC4 Checkout Shi Hui ·
    UC5 Management + base stack Elroy
  - Agenda: changes since the proposal → architecture → use cases → live demo → operations
- **Figure:** small thumbnail of `figures/implementation-architecture.png` on the title card.
- **Speaker notes:** Good afternoon, we are Group 4, and this is TicketMastery, a concert ticketing platform on AWS.
  All five use cases from our proposal are now built and running in our dev account in Singapore, as six ECS
  services, and you will see them live halfway through. Each of us presents the use case we own. I'm Elroy: I own concert management and the
  shared base, monitoring and our management process.

## Slide 2. Business context and requirements

- **Presenter:** Cody · **Minutes:** 0.75
- **On slide:**
  - B2C concert ticketing based in Singapore (theme: Online Shopping System); guests, fans and organisers
  - Base requirement: Asia-Pacific; 80% of customers in Singapore, the rest split evenly across Malaysia, Thailand
    and Hong Kong
  - On-sales spike to 50,000–100,000 concurrent fans, about 10× a normal day (≈ 5,000)
  - Goals: stay up in the spike, sell every seat exactly once, e-tickets within seconds, live sales view
  - 11 NFRs, e.g. p95 < 300 ms, 0 oversold seats, seat free ≤ 30 s after a hold expires, spend < USD 80
- **Figure:** the traffic table from report §2.2 (Origin / Share / How it is served), re-typed on the slide.
- **Speaker notes:** TicketMastery sells concert tickets across Asia-Pacific. We use the specification's base
  requirement: 80% of customers in Singapore, the rest split evenly between Malaysia, Thailand and Hong Kong; our
  proposal draft had a different split, so we corrected it. The conclusion holds either way: one region in Singapore
  plus CloudFront edges in all four markets. The hard part is the spike: a big on-sale brings 50,000 to 100,000 fans
  in minutes. So our two key requirements are staying up during that spike and never selling a seat twice.

## Slide 3. What changed since the proposal, and why

- **Presenter:** Elroy · **Minutes:** 0.75
- **On slide:**
  - Core on ECS Fargate + RDS PostgreSQL instead of the all-serverless write-up: holds, orders and seats change in one
    SQL transaction
  - One API image, six ECS services (one per feature + read-only reporting), each with its own scaling
  - Serverless kept where it fits: waiting room (SQS FIFO, DynamoDB, Lambda) and the e-ticket worker (SNS → SQS →
    Lambda)
  - Public ALB with a secret header → API Gateway VPC link to an **internal** ALB
  - Hold-sweeper Lambda and ElastiCache dropped: the hold `UPDATE` itself reclaims expired holds
  - Deployed in implementation mode (1 AZ, no NAT); the HA design stays in the same Terraform behind variables
- **Figure:** two-column "Proposal → Built" table drawn on the slide (rows as the bullets).
- **Speaker notes:** Our first write-up was all-serverless, with DynamoDB for seats and orders. We moved the core to
  Fargate and PostgreSQL, split into six services, for four reasons: correctness is easier to prove in SQL, organiser reporting is relational,
  it lets us show VPC topics like subnets, security groups and Multi-AZ failover, and the cost is predictable. We kept
  serverless for the waiting room and the e-ticket worker. Three smaller changes: the public ALB with a secret header
  became a VPC link to an internal ALB; the hold-sweeper and Redis went away because one SQL statement handles expired
  holds; and we deploy the cheaper single-AZ mode the instructor asked for.

## Slide 4. Instructor feedback and our response

- **Presenter:** Elroy · **Minutes:** 0.75
- **On slide:**
  - a. API Gateway in front of Fargate → HTTP API with Cognito JWT authorizer, throttling, access logs, VPC link
    (done)
  - b. Per-feature containers → six ECS services from one image, each with its own target group, path rule and
    autoscaling (done)
  - c. DynamoDB for dynamic session data → queue and admissions in DynamoDB; seat holds stay in Postgres (justified)
  - d. Cost of a 1-minute EventBridge schedule → ≈ 43,800 runs/month, inside the free tiers, ≈ USD 0 (done)
  - e. Internal reporting → read-only reporting service (`reporting_ro` login, five SQL views) + Sales reports page;
    QuickSight blocked on the AWS Free plan (done, no BI tool)
- **Figure:** condensed table from report §11 (feedback / response / status).
- **Speaker notes:** At the proposal review we got five pieces of feedback. A: put API Gateway in front; done, and it
  now checks tokens and throttles before anything reaches our task. B: per-feature containers; done. Each
  feature now runs as its own ECS service with its own scaling. C: DynamoDB for session data; the queue is in
  DynamoDB, but holds stay in Postgres so a hold and an order can never disagree. D: the schedule is free-tier. E:
  reporting; done. We built QuickSight in Terraform, but our Free-plan account can't subscribe, so a read-only
  reporting service with its own database login serves a Sales reports page instead.

## Slide 5. Architecture: deployed vs target HA

- **Presenter:** Elroy · **Minutes:** 1.00
- **On slide:**
  - Edge: CloudFront (`PriceClass_200`) + WAF; the SPA from private S3 via OAC; `/api/*` to API Gateway
  - API Gateway HTTP API (Cognito JWT, 100 rps / 200 burst) → VPC link → internal ALB → path rules → six Fargate
    services (discovery, account, waiting-room, checkout, organiser, reporting) → RDS PostgreSQL 16
  - Beside the request path: waiting room (SQS FIFO → `queue-manager` → DynamoDB, Scheduler every minute) and
    e-tickets (SNS → SQS → `ticket-fn` → S3 + SES)
  - Deployed: 1 AZ, no NAT, 6 services × 1 task, single-AZ RDS, ≈ USD 150/month · Target HA: 2 AZs, NAT per AZ,
    ≥ 2 tasks per service (12), Multi-AZ RDS, ≈ USD 311/month (estimates)
  - One `tfvars` block switches between the two; `check` blocks reject invalid combinations
- **Figure:** `figures/implementation-architecture.png` (main), `figures/target-ha-architecture.png` (second build or
  inset). Both are regenerated for the six services.
- **Speaker notes:** This is what is deployed. Fans hit CloudFront with WAF; the React app comes from a private S3
  bucket, and API calls go to API Gateway, which checks the Cognito token and reaches an internal load balancer
  through a VPC link, so the ALB is never on the internet. The ALB routes each path to one of six Fargate services.
  Two event-driven parts sit beside them: the waiting room and the e-ticket pipeline. As the instructor asked, we
  deploy one AZ with no NAT gateway, about 150 dollars a month. The HA design adds a second AZ, NAT per AZ, two tasks
  per service and Multi-AZ RDS for about 311. Both come from the same Terraform; one variable block switches them.

## Slide 6. Resource allocation and justification

- **Presenter:** Cody · **Minutes:** 0.75
- **On slide:**
  - Fargate 6 services × 1 task × 0.25 vCPU / 0.5 GB; each autoscales on CPU 60% and ALB requests per task, max 2–3
    (6 × 11.3 ≈ USD 68)
  - RDS `db.t4g.micro`, 20 GB gp3, encrypted, single-AZ (≈ USD 21): transactions for zero double-booking
  - Internal ALB (≈ 24.2) and one public IP per task (6 × 3.65 ≈ 22) instead of a NAT gateway (≈ 43 per AZ)
  - HTTP API, not REST: its VPC link targets the ALB directly; REST would need an extra NLB (≈ 18+)
  - Spiky parts are pay-per-request: SQS, DynamoDB on-demand, Lambda, Scheduler ≈ USD 0; WAF (1 web ACL, 2 rules)
    ≈ 7; monitoring ≈ 6.3
- **Figure:** condensed version of the report §4 table (layer / configuration / ≈ USD per month).
- **Speaker notes:** We picked the smallest sizes and let the waiting room protect them. Each of the six services runs
  one quarter-vCPU task, and a micro Graviton database is enough because only 500 new buyers per concert per minute
  reach it. The biggest decision was no NAT gateway: each task uses its own public IP for egress, and its security
  group only accepts traffic from the ALB. We chose the HTTP API because its VPC link talks to an ALB directly. We
  rejected ElastiCache for holds, because two stores can disagree. The split cost about 75 dollars a month more.

## Slide 7. Linkage of resources

- **Presenter:** Andrew · **Minutes:** 0.75
- **On slide:**
  - Request path: CloudFront → API Gateway (JWT) → VPC link → internal ALB (path rule per service) → 6 Fargate
    services → RDS
  - Waiting room: API → SQS FIFO `join-queue` (group = concert) → `queue-manager` → DynamoDB `live-queue`; Scheduler →
    admit step
  - E-tickets: checkout → SNS `order-events` → SQS `ticket-queue` (DLQ after 5) → `ticket-fn` → Cognito, S3, SES
  - Security-group chain: VPC link SG → ALB SG (80) → task SG (container port) → RDS SG (5432)
  - One least-privilege IAM role per component (the six API services still share one task role); reporting logs in
    to RDS as `reporting_ro`, SELECT on five views only
- **Figure:** `figures/purchase-sequence.png`.
- **Speaker notes:** This sequence shows how the resources link during an on-sale. The fan's join goes through the API
  into a FIFO queue grouped by concert, so arrival order is kept, and the queue-manager Lambda writes a position into
  DynamoDB. Every minute the scheduler admits the next batch. When the fan holds seats, the API first reads DynamoDB
  to check admission, then runs the hold in Postgres. Payment publishes OrderConfirmed to SNS, which fans out to SQS
  and the ticket Lambda. Inside the VPC each hop only accepts the one before it. Each component has its own IAM role;
  the six API services still share one, which is our next step.

## Slide 8. UC1 Concert discovery

- **Presenter:** Cody & Nai Xin · **Minutes:** 0.50
- **On slide:**
  - Public, no sign-in: list, search (title, artist, venue) and date filters
  - Concert page: ticket types, prices, "N of M left"; seat map with held and sold seats
  - An expired hold shows as available (same rule as checkout)
  - Cache headers: list `max-age=60`, detail `max-age=15`, seat map `no-store`
- **Figure:** `evidence/demo/demo-05-concert-detail.png` (concert page with the seat map).
- **Speaker notes:** Cody: Discovery is the public front door. Anyone can browse and search published concerts by
  title, artist or venue without signing in, and the list and detail are cacheable. Nai Xin: the concert page shows
  each ticket type with its price and how many are left, plus a seat map that refreshes every 15 seconds during a
  sale. The seat map is never cached, and an expired hold already shows as available.

## Slide 9. UC2 My Tickets & Account

- **Presenter:** Andrew · **Minutes:** 0.50
- **On slide:**
  - Cognito sign-up with email verification; display name edited in the Profile card
  - Token checked twice: API Gateway JWT authorizer, then again inside the API
  - My Tickets: the fan's confirmed orders only; another fan's order answers 404
  - PDF download: API checks S3, returns a 300 s pre-signed link; `409` until the PDF exists
- **Figure:** `evidence/demo/demo-13-ticket-page.png` (ticket page with "Download e-ticket (PDF)").
- **Speaker notes:** Fans sign up with Cognito and verify their email. API Gateway checks the access token and the API
  verifies it again, so a misconfigured route can't bypass authorisation. My Tickets lists only your own confirmed
  orders; anyone else's order returns not found. The PDF stays in a private bucket: the API checks it exists and
  returns a five-minute pre- signed link, so the file downloads straight from S3.

## Slide 10. UC3 Virtual waiting room

- **Presenter:** Yan Ting · **Minutes:** 0.75
- **On slide:**
  - Join: API → SQS FIFO (group = concert, dedup = fan + concert) → `queue-manager` gives a position in DynamoDB
  - Admit: EventBridge Scheduler every minute → next 500 fans per concert, only inside the sale window; 15 minutes
    each
  - Conditional updates: overlapping runs never admit anyone twice; the page polls the status every 5 s
  - Checkout refuses a hold without a current admission: `403 not_admitted`
  - NFR-6: 20 fans, 4 admit runs, 0 order inversions
- **Figure:** `evidence/demo/demo-06-waiting-queued.png` and `evidence/demo/demo-07-waiting-admitted.png` side by side.
- **Speaker notes:** The waiting room turns a crowd of 100,000 into a steady stream. Joining sends a message to a FIFO
  queue grouped by concert, so order is kept and a double click is dropped. The queue-manager Lambda hands out
  positions in DynamoDB. Every minute EventBridge Scheduler runs it again to admit the next 500 fans, but only while
  that concert's sale is open, so early joiners keep their place. Admission lasts 15 minutes and checkout enforces it.
  In our fairness test, 20 fans were admitted over four runs with zero inversions.

## Slide 11. UC4 Seat holds, checkout and e-tickets

- **Presenter:** Shi Hui · **Minutes:** 0.75
- **On slide:**
  - A hold is one SQL `UPDATE`: every seat or none, 10 minutes, otherwise `409 seats_unavailable`
  - No sweeper: the same predicate reclaims expired holds (NFR-4: seat free 0.6 s after expiry)
  - Simulated payment: success sells the seats and confirms the order in one transaction; decline or timeout
    releases them
  - `OrderConfirmed` → SNS → SQS → `ticket-fn`: PDF to S3, email through SES; a `.sent` marker makes redeliveries
    do nothing
- **Figure:** the hold SQL from report §6.3 + `evidence/demo/demo-09-checkout-hold.png` (countdown and
  "Pay $184.00").
- **Speaker notes:** This statement is why no seat is sold twice. It updates only seats that are available or whose
  hold has expired, and if fewer rows come back than requested, the whole transaction rolls back. Postgres row locks
  serialise competing fans, and we sort seat IDs so there are no deadlocks. Because expiry is part of the condition,
  we need no sweeper; our test saw a seat free again 0.6 seconds after expiry. Payment is simulated. After it, an
  event goes to the ticket Lambda, which renders the PDF, emails it and writes a marker so a repeat delivery sends
  nothing.

## Slide 12. UC5 Concert management and reporting

- **Presenter:** Elroy · **Minutes:** 0.50
- **On slide:**
  - Cognito group `organisers`, checked by the API; organisers see only their own concerts
  - Draft → ticket types → seat layout (one transaction) → publish; layout locks when the sale opens
  - Live dashboard: available, held, sold and revenue per ticket type, refreshed every 5 s
  - Cancel: every ticket holder is emailed (one `ConcertCancelled` per order → `ticket-fn` → SES)
  - Sales reports page: 7/30/90 days or all, KPIs, revenue charts, CSV; served by the read-only reporting service
- **Figure:** `evidence/demo/demo-18-organiser-reports.png` (Sales reports page); `demo-03-organiser-dashboard.png`
  as a second image if space allows.
- **Speaker notes:** Organisers create a draft, add ticket types and a seat layout, and publish. The whole layout is
  replaced in one transaction, and publishing needs exactly one seat per ticket. Once the sale opens the layout locks,
  enforced in the service and by database triggers. The live dashboard reads the same seat rows checkout updates.
  Cancelling emails every ticket holder. The Sales reports page comes from a separate reporting
  service that logs in as a read-only role and can only read five SQL views.

## Slide 13. Live demo

- **Presenter:** Nai Xin drives; narration by each UC owner (UC5 Elroy, UC1 Cody & Nai Xin, UC3 Yan Ting, UC4 Shi
  Hui, UC2 Andrew, monitoring Elroy) · **Minutes:** 5.50
- **On slide:**
  - https://d1ubso1416lulu.cloudfront.net
  - Organiser: create and publish a concert, open the live dashboard and Sales reports (UC5)
  - Fan: browse (UC1) → waiting room (UC3) → hold and pay (UC4) → My Tickets, PDF and email (UC2)
  - Operations: CloudWatch dashboard `ticketmastery-dev` and an alarm email
- **Figure:** live browser (two Chrome profiles: Organiser, Fan); fallback recording and screenshots per
  `demo-script.md`.
- **Speaker notes:** Nai Xin: We'll now show everything live on our CloudFront URL. On the left is an organiser, on
  the right a fan. The organiser publishes a concert and watches sales and reports; the fan buys two seats for a concert already
  on sale and gets the e-ticket. Each owner explains their part as we go, and Elroy ends with the CloudWatch dashboard
  and an alarm email.

## Slide 14. Monitoring and alerts

- **Presenter:** Elroy · **Minutes:** 0.75
- **On slide:**
  - 30 CloudWatch alarms, all OK; ALARM and OK → SNS → email. Per service: no healthy hosts + at max capacity (12);
    busiest-service CPU and memory (MAX over the six); latency, 5xx, queues, DLQs, Lambda, RDS
  - Thresholds from the NFRs: ALB p95 > 300 ms, 5xx > 1%, healthy hosts < 1, ticket-queue age > 60 s, any DLQ
    message
  - Custom metrics without a NAT: `WaitingRoomSize` and `ETicketDeliveryLatency` as EMF log lines; checkout failures
    from log metric filters
  - Dashboard `ticketmastery-dev`: alarm panel + graphs with threshold lines, one line per service on the ECS graphs
  - First split had 41 alarms; per-service CPU/memory/unhealthy-host copies were noise, so we cut to 30
  - Alerts fired for real in the burst test (API Gateway 5xx and latency, ALB 5xx and latency, then at-max-capacity);
    forced `join-dlq-not-empty` → ALARM and OK emails within the same minute, 0 failed deliveries
- **Figure:** `evidence/nfr2-bursts-latency-cpu.png` (CloudWatch graph of the bursts); screenshot *to take*
  `demo-17-alarm-email.png`.
- **Speaker notes:** Monitoring is its own Terraform module, with 30 alarms. Each service has a no-healthy-host and an
  at-max-capacity alarm; CPU and memory alarm on the busiest service. Copying every alarm per service gave 41, mostly
  noise, so we trimmed. Thresholds come from the NFRs, for example ALB p95 above 300 milliseconds, or an e-ticket
  waiting more than a minute. The queue-manager has no NAT, so it prints its metric as an embedded metric log line. Every alarm emails on both alarm and recovery,
  which is the email you just saw in the demo.

## Slide 15. Scalability and availability

- **Presenter:** Yan Ting · **Minutes:** 0.75
- **On slide:**
  - Layers: CloudFront edge cache → WAF 2,000 req / 5 min per IP → API Gateway 100 rps / 200 burst → waiting room 500
    per concert per minute → ECS autoscaling (CPU 60%, 500 req/task/min)
  - Measured: one 0.25 vCPU task saturates at ≈ 60 req/s; autoscaling takes 4–5 min, so on-sales need pre-scaling
  - 6 Nov, split stack: 10 → 100 req/s, 57,600 requests, 0 dropped, p95 63 ms; only discovery scaled (1 → 3 tasks in
    5.6 min), the other four stayed at 1
  - Spike-facing parts are on-demand: SQS, SNS, DynamoDB, Lambda
  - Deployed: a lost task is replaced by ECS (76 s outage in drill F1); AZ a is a single point of failure (accepted)
  - Target HA: tasks in 2 AZs + Multi-AZ RDS failover (typically 60–120 s, no committed data lost); design only
- **Figure:** `evidence/nfr2-burst-run3-tasks-per-service.png` (6 Nov: running tasks per service, only discovery scales
  1 → 3); `evidence/nfr2-bursts-requests.png` (31 Oct–1 Nov runs) if there is room.
- **Speaker notes:** Scalability is layered: CloudFront serves the app from the edge, WAF and the API Gateway throttle
  shed floods, and the waiting room lets only 500 new buyers per concert per minute reach the API. The burst test
  taught us something: one small task saturates at about 60 requests a second and autoscaling needs four to five
  minutes, so starting from one task we dropped 3% of requests before it caught up. On the split stack the same
  burst dropped nothing, and only discovery scaled, to three tasks; the other services stayed at one. That still took
  5.6 minutes, so organisers' sale times should trigger pre-scaling.

## Slide 16. Evidence: NFR results

- **Presenter:** Shi Hui · **Minutes:** 0.75
- **On slide:**
  - Method: k6 and scripts in `loadtest/`, against the API Gateway URL, 125 Cognito test users; every run saved in
    `loadtest/results/`
  - NFR-3 oversell: 100 admitted fans × 2 runs race for 20 seats → 278 lost races, **0 seats sold twice** (SQL in VPC)
  - NFR-4 hold expiry: seat available 0.6 s after expiry (≤ 30 s) · NFR-6 fairness: 4 admit runs, 0 inversions
  - NFR-1 browse p95 30 ms (< 300) · NFR-2 10× burst: 3.3% failed from 1 task, 0 from 2 tasks; 6 Nov split stack
    0 dropped, p95 63 ms, scale-out 5.6 min (≤ 5 not met)
  - NFR-5 task loss: 76 s outage (≤ 5 min) · NFR-7 e-tickets: 10/10 within 60 s, p95 9.9 s
  - NFR-8/9 restore: RPO 2.8 min, RTO 9 min · NFR-10 security config: pass · NFR-11 October spend USD 22.92, all
    credits
- **Figure:** results table from report §10, condensed to NFR / target / measured / pass.
- **Speaker notes:** Every NFR has a repeatable script, run against the live stack. The key result is correctness:
  two hundred admitted fans raced for twenty seats, 278 lost the race cleanly, and SQL run inside the VPC found no
  seat sold twice. Expired holds come back within a second, and the queue admits strictly in arrival order. We also
  report what didn't pass first time: from a single task, the 10-times burst dropped 3% of requests, and the first
  e-ticket run hit an IAM gap that we fixed; those orders were retried from the queue and none were lost.

## Slide 17. Management approach: code, pipeline, review

- **Presenter:** Elroy · **Minutes:** 0.75
- **On slide:**
  - Terraform: one root `infra/envs/dev`, one module per area with one owner; remote state in versioned S3 with
    S3-native locking
  - Every change is `plan -out` → review → `apply` of that plan, announced to the team first
  - CI/CD: frontend type-check and build on PRs, deployed from `main` through GitHub OIDC (no AWS keys). The API is
    not in CI: its image is built, tagged with the git SHA, pushed to ECR (scanned) and rolled out to the six services
    with Terraform by hand; circuit-breaker rollback
  - Trunk-based branches, Conventional Commits, CODEOWNERS per module, migration and Lambda, PR template checklist
  - API tests against real Postgres: seat-hold race, layout triggers, reporting views
- **Figure:** module ownership table from report §9.1.
- **Speaker notes:** Everything is Terraform. One root module wires one module per area, and each module has one
  owner, the same person who presents that part today. State is shared in a versioned S3 bucket with locking, so only
  one apply runs at a time, and every change is planned, reviewed and applied from the saved plan after telling the
  team. Only the frontend deploys from CI, through GitHub OIDC, so no AWS keys are stored in GitHub; the API
  image we push and roll out with Terraform ourselves. CODEOWNERS routes
  each pull request to the owner of what it touches. Our tests run against real Postgres, including the race for the
  same seats.

## Slide 18. Security, backup and DR

- **Presenter:** Andrew · **Minutes:** 0.50
- **On slide:**
  - HTTPS at the edge, WAF, S3 only through OAC; database private, encrypted, TLS from the API
  - DB password generated by RDS in Secrets Manager; `reporting_ro` password set inside the VPC, stored in a secret
    Terraform creates empty: neither in code, `tfvars` or state
  - Task loss target ≤ 5 min (drill F1: 76 s outage); data corruption: point-in-time restore, RPO ≤ 30 min,
    RTO ≤ 1 h (drill F4: RPO 2.8 min, database back in 9 min 14 s)
  - AZ and region loss: design only · Accepted dev gaps: HTTP inside the VPC, MFA off, SES sandbox
- **Figure:** condensed tables from report §9.5 and §9.6.
- **Speaker notes:** Security is layered from the edge in: HTTPS only, WAF rules, a bucket reachable only through
  CloudFront, tokens checked twice, and a private, encrypted database. No password is in our code or state: RDS
  generates the master one, and the reporting password is set inside the VPC. We ran both drills: stopping the only task caused a 76-second outage, and a
  point-in-time restore had the database back in nine minutes with under three minutes of data loss. AZ and region
  loss are design-only.

## Slide 19. Cost and Budgets

- **Presenter:** Cody · **Minutes:** 0.50
- **On slide:**
  - Deployed ≈ USD 150/month for the whole stack (≈ 5.0/day); target HA ≈ USD 311/month (≈ 10.2/day); estimates
  - Split into six services: +5 tasks × (11.3 Fargate + 3.65 IPv4) ≈ +75; 30 alarms + dashboard ≈ 6.3
  - Largest saving: no NAT gateways (two with Elastic IPs ≈ USD 94/month)
  - AWS Budgets, USD 80/month: alerts at 20, 40, 60, 80 actual and on a forecast above 80; the new run rate exceeds
    80, so the forecast alert will fire
  - `terraform destroy` after work sessions; about 15 minutes to recreate
  - Spend to date: USD 22.92 of usage in October (USD 2.02/day measured), all covered by credits (NFR-11); AWS Free
    plan, USD 123.33 credits left on 6 Nov, expiring 2027-02-18
- **Figure:** cost table from report Appendix B; Budgets console screenshot *to take* (`ticketmastery-dev-monthly-cost`).
- **Speaker notes:** Six services cost more: about 150 dollars a month deployed, against about 311 for the HA design
  with two tasks per service. That is above our 80-dollar budget if left running, so Budgets will warn us and we
  destroy the stack after work sessions. October cost 23 dollars, all credits; 123 dollars of credit is left.

## Slide 20. Limitations and future work

- **Presenter:** Nai Xin · **Minutes:** 0.50
- **On slide:**
  - HA and Multi-AZ RDS are design-only, as the instructor said: a `tfvars` change, ≈ USD 311/month
  - No BI tool (QuickSight blocked on the Free plan); reporting replica design-only; refunds on cancellation are
    only promised in the email, not processed
  - Concert list not cached at CloudFront (`/api/*` uses `CachingDisabled`); API image still deployed by hand; one
    task role shared by the six services; scale-out 5.6 min, so pre-scale
  - Before production: real payments (Stripe), SES production access, HTTPS on the ALB, Cognito MFA, bot protection
- **Figure:** none (text slide).
- **Speaker notes:** Some things are deliberately not done. HA is designed and one variable change away; the
  instructor said a design was enough. We have no BI tool, because our Free-plan account can't subscribe to QuickSight.
  Cancelling a concert emails every ticket
  holder, but the refund it promises is not processed, because payments are simulated. Before real customers we'd
  cache the concert list at CloudFront and add Stripe payments, SES production access, HTTPS on the ALB, MFA and bot
  protection.

## Slide 21. Summary and Q&A

- **Presenter:** Elroy · **Minutes:** 0.50
- **On slide:**
  - Five use cases on six ECS services, deployed and shown live on CloudFront
  - No seat sold twice: one all-or-nothing SQL `UPDATE`, tested under a race
  - The waiting room caps the spike at 500 buyers per concert per minute
  - Run as code: Terraform modules, CI/CD, CloudWatch alarms and Budgets
- **Figure:** small `figures/implementation-architecture.png`.
- **Speaker notes:** To sum up: all five use cases are built as six services, and you saw them work together live. Two choices carry
  the system: one SQL statement that holds seats all-or-nothing, so no seat is sold twice, and a waiting room that
  admits 500 fans per concert per minute, so a small stack survives an on-sale. Thank you; we're happy to take
  questions.
