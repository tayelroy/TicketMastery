# TicketMastery live demo script

Final presentation, slide 13. **Slot: 5 min 30 s** (hard stop 6:00; the deck keeps 1 minute of buffer).
Site: **https://d1ubso1416lulu.cloudfront.net**

Every label below is copied from `frontend/src` (the quoted text is what appears on screen). Some labels are shown
in capitals by CSS (for example the waiting room's "Your queue number" appears as YOUR QUEUE NUMBER, and eyebrow
labels such as "Order confirmed"). Prices assume the demo concert set up below: CAT1 at S$88, so two CAT1 seats cost
$176 + a S$4 booking fee per seat = **$184.00**.

## Roles

| Who | Does |
|---|---|
| Nai Xin | Drives the presenter laptop: every click and keystroke below |
| Elroy | Narrates UC5 and operations; runs the alarm command from his own laptop at 0:00 |
| Cody & Nai Xin | Narrate UC1 |
| Yan Ting | Narrates UC3, including the admit schedule while the fan waits |
| Shi Hui | Narrates UC4 and the e-ticket pipeline |
| Andrew | Narrates UC2 (sign-in, My Tickets, PDF, email) |
| Cody | Timekeeper: holds up "1 min left" at 4:30 and calls the cuts below if a step overruns |

## Screen layout

Two Chrome profiles side by side, so the organiser and the fan each keep their own Cognito session (Amplify stores
one session per browser profile).

- **Left: Chrome profile "Organiser"** (signed in as the organiser account)
  - Tab 1: `https://d1ubso1416lulu.cloudfront.net/organiser` ("My concerts")
  - Tab 2: the organiser page of the demo concert, `/organiser/concerts/<demo concert id>`
  - Tab 3: CloudWatch dashboard `ticketmastery-dev`
    (`https://ap-southeast-1.console.aws.amazon.com/cloudwatch/home?region=ap-southeast-1#dashboards/dashboard/ticketmastery-dev`)
  - Tab 4: the alert inbox (`tayelroy@gmail.com`, the SNS `ticketmastery-dev-alerts` subscriber)
- **Right: Chrome profile "Fan"** (signed **out**; the password is saved in the profile's password manager)
  - Tab 1: `https://d1ubso1416lulu.cloudfront.net/`
  - Tab 2: the fan's mailbox (the address that is a verified SES identity), Spam folder checked as well
- **Elroy's laptop:** a terminal with an AWS session for the dev account and this command typed, not yet run:

  ```bash
  aws cloudwatch set-alarm-state --region ap-southeast-1 \
    --alarm-name ticketmastery-dev-join-dlq-not-empty \
    --state-value ALARM --state-reason "Live demo: alert email test"
  ```

## Pre-demo checklist

### The day before (T-1 day)

- [ ] **Stack is up.** Open the site: the footer shows "API ok (…)", not "API unreachable".
  `curl https://d1ubso1416lulu.cloudfront.net/health` returns `200` with `"status":"ok","db":"ok"`.
- [ ] **Organiser account.** It is in the Cognito group `organisers` and has signed out and in again since being
  added. Signed in, the header shows the `organisers` badge and an "Organiser" link.
- [ ] **Fan account** (and a **backup fan** account set up the same way):
  - signed up and email-verified in Cognito;
  - on "My Tickets" (`/myaccount`), Profile card → "Display name" = `Demo Fan` → "Save profile" → "Saved.";
  - **the fan's email address is a verified SES identity** (SES console → Identities → status *Verified*). SES is in
    the sandbox, so mail to an unverified address fails with `MessageRejected` and the order's e-ticket ends up in
    `ticket-dlq`.
- [ ] **SES sender verified:**
  `aws sesv2 get-email-identity --email-identity <ses_from_address> --query VerifiedForSendingStatus` → `true`.
- [ ] **SNS subscription confirmed:** SNS console → Subscriptions → the email subscription on
  `ticketmastery-dev-alerts` shows *Confirmed*, not *PendingConfirmation* (until confirmed, alarm emails are dropped).
- [ ] **Create the demo concert** (organiser profile). Its sale must already be open during the presentation,
  because `queue-manager` only admits fans inside the sale window. The API only accepts a sale start in the future,
  and ticket types, layout and publish must all be done **before** the sale opens (after that the layout is locked:
  `409 layout_locked`). So:
  1. "Organiser" → "+ New concert".
  2. Title `TicketMastery Demo Night`, Artist `The Cloud Engineers`, Venue `Singapore Indoor Stadium`.
  3. "Sale opens": about **15 minutes from now** (the laptop must be on Singapore time: the field is local time).
     Leave "Sale closes" and "Show starts" at their defaults (about 4 weeks ahead, so the sale is still open on
     10 Nov).
  4. "Create draft". The concert page opens with status "Draft".
  5. "Ticket types": row 1 Name `CAT1`, Price `88`, Quantity `40`, Max / order `4`; "+ Add ticket type"; row 2
     Name `CAT2`, Price `128`, Quantity `20`, Max / order `4`; "Save ticket types" (the form reloads and the "Seat
     layout" panel appears).
  6. "Seat layout" is pre-filled (section `Floor`, rows A and B for CAT1 seats 1–20, row C for CAT2 seats 1–20);
     the tally shows "CAT1: 40 / 40 seats" and "CAT2: 20 / 20 seats". "Save layout" → "Saved".
  7. "Get ready to publish" → "Publish concert". Status becomes "Published".
  8. After the sale opens, reload: the page shows "Ticket types and the seat layout are locked because the sale has
     started." The public page shows "On sale now until …" and a "Get tickets" button.
  9. Copy the concert's organiser URL into the Organiser profile's tab 2.
- [ ] **Dress rehearsal** of the whole script, with a screen recording (QuickTime → New Screen Recording) saved on
  the presenter laptop's desktop as `demo-full-run.mov`, and the screenshots in [Fallback assets](#fallback-assets)
  saved to `docs/report/evidence/demo/`.
- [ ] CloudWatch → Alarms: nothing in ALARM, `ticket-dlq` and `join-queue-dlq.fifo` empty, so the dashboard is green
  before the demo.

### One hour before (T-60 min)

- [ ] **Organiser signed in** in the Organiser profile. The Cognito access token lasts **60 minutes**; Amplify
  refreshes it from the 7-day refresh token while the app is open, so reload tab 1 just before the slot. If a page
  shows "Checking sign-in…" for long or lands on "Sign in", sign in again.
- [ ] **Fan signed out** in the Fan profile (header shows "Sign in"); the password autofills.
- [ ] **AWS console** signed in (Organiser profile, tab 3) and **Elroy's CLI session fresh**:
  `aws sts get-caller-identity` shows the dev account.
- [ ] **Demo concert on sale:** Organiser tab 2 shows the lock banner and a "Sales" panel marked "Live · updated …".
- [ ] **No leftover admission or hold for the demo fan.** An admission lasts **15 minutes**; a fan still admitted
  skips straight to "You're in!", which hides the queue. A hold lasts **10 minutes**, and a fan can have only one
  active hold per concert. The last rehearsal must end at least 15 minutes before the slot, and any hold must be
  released ("Change seats") or expired. Otherwise use the backup fan.
- [ ] Enough CAT1 seats left in row A or B (each run sells 2).

### Ten minutes before (T-10 min)

- [ ] Open the tabs listed in [Screen layout](#screen-layout); browser zoom 125%; macOS notifications off (Focus
  mode); the Downloads button visible in the Chrome toolbar.
- [ ] **CloudFront cache:** hard-reload every site tab (Cmd+Shift+R). `index.html` is served with `no-cache` and
  every frontend deploy invalidates `/*`, but if anyone deployed the frontend today, confirm the invalidation
  finished (CloudFront console → Invalidations → *Completed*). `/api/*` is never cached by CloudFront
  (`CachingDisabled`); the browser itself caches the concert list for 60 s and a concert's detail for 15 s, so after
  publishing, reload the fan's page before looking for the new concert.
- [ ] Fallback recording open in QuickTime, paused at 0:00; `docs/report/evidence/demo/` open in Finder.
- [ ] Phone hotspot ready in case the venue Wi-Fi fails.

## Run sheet

| Time | Step | Narrator | Cut if late |
|---|---|---|---|
| 0:00 | Elroy runs the alarm command; Nai Xin introduces (slide 13 notes) | Nai Xin | — |
| 0:20 | 1. Organiser creates and publishes a concert (UC5) | Elroy | Skip to step 2; show `demo-02` |
| 1:30 | 2. Live sales dashboard of the demo concert (UC5) | Elroy | — |
| 1:50 | 3. Fan signs in and browses (UC1) | Cody, Nai Xin | Skip the search |
| 2:30 | 4. Waiting room: queued, then admitted (UC3) | Yan Ting | — (the wait is fixed by the schedule) |
| 3:30 | 5. Seats, hold, payment (UC4) | Shi Hui | Skip the organiser "Held" check |
| 4:30 | 6. My Tickets, ticket, PDF, email (UC2 + ticket-fn) | Andrew | Skip opening the PDF |
| 5:05 | 7. CloudWatch dashboard and alarm email | Elroy | Show only the email |
| 5:30 | Back to slides (slide 14) | Elroy | — |

## Steps

### 0. Alarm command and intro (0:00–0:20)

- **Do (Elroy, own laptop):** press Enter on the prepared `set-alarm-state` command. It prints nothing on success.
  The ALARM email will be waiting in the alert inbox by step 7.
- **Say (Nai Xin):** slide 13 notes.

### 1. UC5: organiser creates and publishes a concert (0:20–1:30)

- **Do:** Organiser profile, tab 1 ("My concerts") → click **"+ New concert"**.
- **Audience sees:** form "New concert", "Saved as a draft. Add ticket types and a seat layout next, then publish."
- **Do:** Title `Encore Night`, Artist `The Cloud Engineers`, Venue `Esplanade Concert Hall`. Leave "Sale opens",
  "Sale closes" and "Show starts" at their defaults (the sale opens in a week). Click **"Create draft"**.
- **Audience sees:** the concert page with status "Draft" and the "Ticket types" table (Name, Description,
  Price (SGD), Quantity, Max / order).
- **Do:** Name `CAT1`, Price `88`, Quantity `20` (Max / order stays `4`) → **"Save ticket types"**.
- **Audience sees:** the ticket types form reloads with the saved row, and a "Seat layout" panel appears: "No layout
  saved yet. A starting layout is filled in from your ticket types; adjust it and save." and the tally
  "CAT1: 20 / 20 seats".
- **Do:** **"Save layout"**.
- **Audience sees:** "Saved" and "Saved layout: 1 section(s), 1 rows, 20 seats. Saving below replaces it."; below,
  a "Get ready to publish" checklist with **"Publish concert"**.
- **Do:** **"Publish concert"**.
- **Audience sees:** status "Published", a "View public page" button, and a "Sales" panel: "Sold 0 / 20",
  "Held in checkout 0", "Available 20", "Revenue $0".
- **Say (Elroy):** only the `organisers` Cognito group can reach this page, and the API checks the group again.
  The layout is saved in one transaction, and publish refuses unless every ticket has exactly one seat. Once the
  sale opens, ticket types and layout lock, in the service and in database triggers.
- **If it fails:** show `demo-01-organiser-create.png` and `demo-02-organiser-published.png`, then go to step 2.

### 2. UC5: live dashboard of the demo concert (1:30–1:50)

- **Do:** Organiser tab 2 (TicketMastery Demo Night).
- **Audience sees:** status "Published", the banner "Ticket types and the seat layout are locked because the sale
  has started.", and the "Sales" panel with "Live · updated <time>" and the table Ticket type / Sold / Held /
  Available / Revenue for CAT1 and CAT2.
- **Say (Elroy):** this is the concert the fan is about to buy from. Its sale is open, so the layout is locked. The
  panel polls every 5 seconds and counts straight from the seat rows that checkout updates. Keep an eye on "Held in
  checkout".
- **If it fails:** `demo-03-organiser-dashboard.png`.

### 3. UC1: fan signs in and browses (1:50–2:30)

- **Do:** Fan profile, tab 1. Header → **"Sign in"**.
- **Audience sees:** "TicketMastery account" / "Sign in" with fields "Email" and "Password".
- **Do:** autofill Email and Password → **"Sign in"**.
- **Audience sees:** home page "Hello Demo Fan", "Find your next live night.", the search box "Search all events…"
  and "Upcoming Events" with "N shows" and the concert cards.
- **Do:** type `Demo` in "Search all events…".
- **Audience sees:** the card "TicketMastery Demo Night", "Singapore Indoor Stadium · <time>", "From $88".
- **Do:** click the card.
- **Audience sees:** artist "The Cloud Engineers", "TicketMastery Demo Night", "When" / "Where", the green banner
  "On sale now until <date>.", a **"Get tickets"** button, "Tickets" (CAT1 "$88" "N of 40 left", CAT2 "$128"
  "N of 20 left"), and "Seat map" with "Stage", rows A–C and the legend "Held" / "Sold".
- **Say (Cody, Nai Xin):** browsing is public and cacheable; the seat map is never cached and refreshes every
  15 seconds during a sale. Sold seats from earlier runs are greyed out.
- **If it fails:** `demo-04-home.png`, `demo-05-concert-detail.png`. If sign-in fails, switch to the backup fan.

### 4. UC3: waiting room (2:30–3:30)

- **Do:** click **"Get tickets"** (goes to `/concerts/<id>/waiting-room`).
- **Audience sees:** "Waiting room · The Cloud Engineers", the concert title, then a spinner with "Assigning your
  queue number…" and "This only takes a moment. Please don't close this tab."
- **Audience sees (a few seconds later):** YOUR QUEUE NUMBER, a "Live" tag, "#<n>", "<n> people ahead of you" and a
  progress bar; below, "While you wait" with "Keep this tab open." and "Be ready. When it's your turn you'll have
  15 minutes to choose your seats."
- **Say (Yan Ting), while waiting:** the join went from the API into an SQS FIFO queue grouped by this concert, and
  the queue-manager Lambda gave us this number in DynamoDB. Nobody is admitted on request: EventBridge Scheduler
  runs queue-manager once a minute, and each run admits the next 500 fans for every concert whose sale window is
  open. Admission is a conditional update, so two overlapping runs can't admit anyone twice. The page polls our
  status every 5 seconds. The number may be above 1 because earlier rehearsals joined this concert; "people ahead"
  only counts fans not yet admitted. Expect the next run within a minute.
- **Audience sees (about 30–60 s after joining):** "Queue number #<n>", **"You're in!"**, "Your spot is held for
  14:5x. Choose your seats before it runs out." and the button **"Continue to seat selection"**.
- **Say (Yan Ting):** we now have 15 minutes. Checkout reads the same DynamoDB row; without it, a hold gets
  `403 not_admitted` and the page sends you back here.
- **If it fails:**
  - "Couldn't join the queue" with "Try again": click "Try again" once; if it repeats, show `demo-06` and `demo-07`.
  - "You're in!" appears immediately: this fan was admitted within the last 15 minutes; say so and continue.
  - "Your turn has expired": click **"Rejoin the queue"** (an expired fan joins again at the back).
  - Not admitted after 90 s: keep talking for one more minute (one more scheduled run); then show `demo-07` and
    switch the rest of the demo to the recording.

### 5. UC4: seats, hold and payment (3:30–4:30)

- **Do:** click **"Continue to seat selection"**.
- **Audience sees:** steps "1 Select seats · 2 Checkout · 3 Confirmation", the seat map (seat-number buttons per
  row, "Stage"), the legend "CAT1 $88.00", "CAT2 $128.00", "Selected", "Unavailable", and an "Order summary" box
  with "Select seats on the map." and a disabled **"Checkout"** button.
- **Do:** click two free CAT1 seats next to each other in row A or B.
- **Audience sees:** order summary lines "Floor · Row A · Seat <n>" (CAT1, $88.00) ×2, "Subtotal $176.00",
  "Booking fee ($4.00 × 2) $8.00", "Total $184.00", "Your seats are reserved for 10 minutes while you pay."
- **Do:** **"Checkout"**.
- **Audience sees:** step 2: "Your seats are reserved for **9:5x**", "Complete payment before the timer runs
  out.", "Order summary", "Payment", "Payment is simulated for this project, so no card details are needed.", the
  checkbox "Simulate a declined payment (demo)", **"Pay $184.00"** and "Change seats".
- **Do:** switch to Organiser tab 2 for 5 seconds.
- **Audience sees:** "Held in checkout" is up by 2 after the next 5-second refresh.
- **Say (Shi Hui):** both seats were taken by one SQL UPDATE in Postgres: all of them or none. Had another fan got
  one first, nothing would be held and we'd get "Some of those seats were just taken." A hold lasts 10 minutes and
  expired holds free themselves; no sweeper job is needed.
- **Do:** back to the Fan profile; leave the checkbox **unticked** → **"Pay $184.00"**.
- **Audience sees:** "Order confirmed", "You're going to TicketMastery Demo Night!", the seat lines and totals,
  "Your e-tickets are on their way by email. You'll also find them under My Tickets.", buttons "My Tickets" and
  "More concerts".
- **Say (Shi Hui):** the seats became sold and the order confirmed in one transaction. The API then published
  OrderConfirmed to SNS; SQS hands it to the ticket-fn Lambda, which renders the PDF to S3 and emails it through
  SES, so checkout never waits for the email.
- **Do not click "More concerts"**: it links to `/concerts`, which has no route and shows the 404 page "This show
  isn't on the lineup".
- **Optional, only if ahead of time (≈ 30 s), before paying:** tick "Simulate a declined payment (demo)" →
  "Pay $184.00" → the notice "Payment was declined and your seats were released. Please select again." and the seat
  map reloads. Select the seats again → "Checkout" → **untick the box** (it stays ticked after the decline) →
  "Pay $184.00". The admission is still valid, so no new queue.
- **If it fails:**
  - "Some of those seats were just taken. The seat map has been refreshed, please select again.": pick two other
    seats.
  - "You already have seats reserved for this concert.": a rehearsal hold is still active; the page shows its
    countdown, so pay that one.
  - Sent back to the waiting room: the admission was missing or expired; show `demo-08` to `demo-11` instead.

### 6. UC2: My Tickets, ticket page, PDF and email (4:30–5:05)

- **Do:** header → **"My Tickets"** (`/myaccount`).
- **Audience sees:** "My Tickets", "Upcoming", a row "TicketMastery Demo Night", "<DATE> · <TIME>",
  "Singapore Indoor Stadium · 2 seats", "View ticket ›", and below it the "Profile" card (Email, Display name,
  "Save profile"). A fan with no orders would see "No tickets yet. Find a concert to get started."
- **Do:** click the new row (the top one if there are several from rehearsals).
- **Audience sees:** "Ticket" with the concert title and artist, "Date", "Time", "Venue", "Order" (first 8
  characters of the order ID), "Seats" with "Floor · Row A · Seat <n>" "CAT1 · $88.00", "Booking fee $8.00",
  "Total paid $184.00", and **"⤓ Download e-ticket (PDF)"**.
- **Do:** **"⤓ Download e-ticket (PDF)"** (shows "Preparing…"), then open `ticketmastery-<orderId>.pdf` from
  Chrome's Downloads.
- **Audience sees:** the PDF: concert, artist, VENUE, STARTS (time with "SGT"), ORDER (full order ID) with a QR code,
  one line per seat with prices as "SGD 88.00", subtotal, booking fee, total "SGD 184.00".
- **Do:** Fan profile, tab 2 (mailbox); open the newest email.
- **Audience sees:** from "TicketMastery", subject **"Your e-ticket: TicketMastery Demo Night"**, body starting
  "Thank you for your order. Your e-ticket is attached as a PDF.", the seats, "Total paid: SGD 184.00", the full
  order ID, and the attachment `ticketmastery-<orderId>.pdf`.
- **Say (Andrew):** this page only returns orders that belong to the signed-in fan; anyone else's order ID answers
  not found. The PDF lives in a private bucket: the API checks it exists, then hands the browser a pre-signed link
  valid for five minutes, and the file comes straight from S3. The email came from the same Lambda.
- **If it fails:**
  - "Your e-ticket is still being prepared. Try again in a minute.": the PDF isn't written yet (`409`). Open the
    email first, then retry the download.
  - No email after ~1 minute: check Spam (the sender is a Gmail address without DKIM, so some providers file it
    there); otherwise show `demo-15-eticket-email.png`.
  - Download error: show `demo-14-eticket-pdf.png`.

### 7. Operations: dashboard and alarm email (5:05–5:30)

- **Do:** Organiser tab 2 for 3 seconds: "Sold" is up by 2 and "Held in checkout" is back down.
- **Do:** Organiser tab 3 (CloudWatch dashboard `ticketmastery-dev`); refresh.
- **Audience sees:** the alarm-status panel and the graphs with threshold lines, e.g. API Gateway requests with the
  demo's traffic, ALB latency, ECS CPU, ticket-queue age and e-ticket delivery latency. The forced alarm
  `ticketmastery-dev-join-dlq-not-empty` shows ALARM until its next evaluation, then OK.
- **Do:** Organiser tab 4 (alert inbox); open the newest email from AWS Notifications.
- **Audience sees:** the SNS alarm email for `ticketmastery-dev-join-dlq-not-empty` with the reason "Live demo: alert
  email test". The usual subject format is `ALARM: "ticketmastery-dev-join-dlq-not-empty" in Asia Pacific
  (Singapore)`; confirm the exact wording in the rehearsal. An "OK" email follows when the alarm re-evaluates.
- **Say (Elroy):** we forced one alarm at the start of the demo to prove the path from CloudWatch through SNS to
  email. Every alarm sends its ALARM and OK transitions the same way. Back to the slides for the details.
- **If it fails:** console session expired → show `demo-16-cloudwatch-dashboard.png`; no email → show
  `demo-17-alarm-email.png`.

## Whole-demo fallback

If the site is down (footer "API unreachable", or API Gateway's `{"message":"Service Unavailable"}`), or the
Wi-Fi and the hotspot both fail: switch to `demo-full-run.mov` in QuickTime and narrate the same steps over it.
Do not debug on stage. For a single failed step, use that step's screenshot and carry on live.

## Fallback assets

Take these during the dress rehearsal and save them to `docs/report/evidence/demo/`. The slides reuse some of them.
`demo-01` to `demo-14` were taken on 3 Nov 2026 on cancelled rehearsal copies of the two concerts (test organiser and
a test fan named "Demo Fan"); retake them at the dress rehearsal only if the UI changes. `demo-15` to `demo-17` and
the recording need the real inboxes and console, so they are still to take.

| File | Shows | Step / slide |
|---|---|---|
| `demo-01-organiser-create.png` | "New concert" form filled in | 1 |
| `demo-02-organiser-published.png` | New concert "Published" with "Sales" 0 / 20 | 1 |
| `demo-03-organiser-dashboard.png` | Demo concert: lock banner + "Sales" panel "Live · updated …" | 2, slide 12 |
| `demo-04-home.png` | "Hello Demo Fan", "Upcoming Events" | 3 |
| `demo-05-concert-detail.png` | "On sale now until …", "Get tickets", tickets, seat map | 3, slide 8 |
| `demo-06-waiting-queued.png` | YOUR QUEUE NUMBER "#n", "n people ahead of you" | 4, slide 10 |
| `demo-07-waiting-admitted.png` | "You're in!", "Your spot is held for 14:5x", "Continue to seat selection" | 4, slide 10 |
| `demo-08-checkout-seats.png` | Two seats selected, "Total $184.00", "Checkout" | 5 |
| `demo-09-checkout-hold.png` | "Your seats are reserved for 9:5x", "Pay $184.00" | 5, slide 11 |
| `demo-10-dashboard-held.png` | Organiser "Held in checkout" 2 | 5 |
| `demo-11-order-confirmed.png` | "Order confirmed", "You're going to …!" | 5 |
| `demo-12-my-tickets.png` | "My Tickets" list with the order | 6 |
| `demo-13-ticket-page.png` | Ticket page with "⤓ Download e-ticket (PDF)" | 6, slide 9 |
| `demo-14-eticket-pdf.png` | The opened PDF with the QR code | 6 |
| `demo-15-eticket-email.png` | "Your e-ticket: TicketMastery Demo Night" with the attachment | 6 |
| `demo-16-cloudwatch-dashboard.png` | Dashboard `ticketmastery-dev` | 7, slide 14 |
| `demo-17-alarm-email.png` | ALARM email for `ticketmastery-dev-join-dlq-not-empty` | 7, slide 14 |
| `demo-full-run.mov` | Whole run, start to finish (keep on the laptop; too large for the repo) | all |

## Reset

### Between rehearsals

- **Holds:** if a run stopped at step 2 of checkout, release the hold with **"Change seats"** ("Changing seats
  releases your reserved seats so others can book them."), or wait the 10 minutes.
- **Admissions:** wait 15 minutes before the next run with the same fan, or use the backup fan.
- **Concert created in step 1:** cancel it (below), so the public list doesn't fill with copies of "Encore Night".
- **The demo concert stays.** Sold seats accumulate (60 seats, 2 per run). If CAT1 runs low, create a new demo
  concert as in the T-1 checklist, at least 15 minutes before it is needed.
- **Forced alarm:** nothing to do; it returns to its real state (OK) on its next evaluation and sends an OK email.
  Check CloudWatch → Alarms before the next run.

### Cancelling a concert (organiser)

1. Organiser profile → "Organiser" → click the concert in "My concerts".
2. At the bottom, click **"Cancel this concert…"**.
3. The "Cancel concert" panel: "This cannot be undone. Fans will see the reason on the concert page." Type a
   "Reason", e.g. `Demo finished`, then click **"Cancel concert"** ("Keep it" closes the panel).
4. The status becomes "Cancelled" with the banner "Cancelled: Demo finished". The concert leaves the public list;
   its public page shows "This concert has been cancelled: Demo finished". Fans who bought keep their order: My
   Tickets shows a "Concert cancelled" badge and the ticket page "This concert has been cancelled." Within seconds
   each ticket holder gets the email "Cancelled: <concert title>" with the reason and the refund amount (only to
   SES-verified addresses while SES is in the sandbox).

### After the final presentation

1. Cancel "Encore Night" (all copies) and "TicketMastery Demo Night" as above.
2. Release any open hold ("Change seats").
3. Sign out of both profiles (header → "Sign out"; this also revokes the refresh token).
4. Confirm `ticketmastery-dev-join-dlq-not-empty` is back to OK and nothing else is in ALARM.
5. Waiting-room rows in DynamoDB `live-queue` expire through TTL; nothing to delete.
6. Cost: when the team agrees the stack is no longer needed, announce it in the group chat and run
   `terraform destroy` as in `docs/deploy.md` (it also removes the Budgets budget).
