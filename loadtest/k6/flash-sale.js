// Flash-sale simulation: a crowd of signed-in fans does what the web app does during an on-sale, while anonymous
// browsing runs alongside. Plan and pass criteria: docs/plans/flash-sale-simulation.md. Normally started by
// scripts/flash-sale.sh, which creates the users and the concert and collects the AWS-side evidence.
//
// Each fan (one VU): arrives in a front-loaded wave -> concert page -> joins the waiting room -> polls the status
// every POLL_SEC until admitted -> picks 1-3 seats (front rows preferred, so fans compete) -> holds them (retries on
// 409 seats_unavailable) -> pays (PAY_FAIL_RATE declined, then tries again) or abandons (ABANDON_RATE, releases the
// hold). Every fan logs one `FANRESULT {json}` line (outcome, position, timings, 429s) for the wrapper's report.
//
//   FANS=400 FAN_OFFSET=0      fans from tokens.json (scripts/cognito-users.sh)
//   ARRIVAL_SEC=60             arrival window; most fans arrive in its first third
//   POLL_SEC=5                 waiting-room poll interval (the page polls every 5 s)
//   BACKOFF=0                  1 = jittered exponential backoff on 429 (the production fix in report section 2.2)
//   ADMIT_TIMEOUT_SEC=900      a fan still not admitted after this gives up
//   MAX_ATTEMPTS=6             holds/payments tried before a fan gives up
//   PAY_FAIL_RATE=0.05 ABANDON_RATE=0.05
//   THINK_MIN_SEC=2 THINK_MAX_SEC=10   seat choice and payment think time (each)
//   BROWSE_RPS=0 BROWSE_DURATION=8m    anonymous list/detail/seat-map requests alongside the sale
//
//   k6 run --console-output results/fans.log --log-format raw k6/flash-sale.js
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { call, errorCode, json, seatMap } from './lib/api.js';
import { browseOnce, browseSetup } from './lib/browse.js';
import { FAN_COUNT, fan, intEnv, requireConcertId, strEnv } from './lib/config.js';
import { metric, round, table, writeResults } from './lib/summary.js';

const FANS = intEnv('FANS', 40);
const FAN_OFFSET = intEnv('FAN_OFFSET', 0);
const ARRIVAL_SEC = intEnv('ARRIVAL_SEC', 60);
const POLL_SEC = intEnv('POLL_SEC', 5);
const BACKOFF = intEnv('BACKOFF', 0) === 1;
const ADMIT_TIMEOUT_SEC = intEnv('ADMIT_TIMEOUT_SEC', 900);
const MAX_ATTEMPTS = intEnv('MAX_ATTEMPTS', 6);
const PAY_FAIL_RATE = intEnv('PAY_FAIL_RATE', 0.05);
const ABANDON_RATE = intEnv('ABANDON_RATE', 0.05);
const THINK_MIN_SEC = intEnv('THINK_MIN_SEC', 2);
const THINK_MAX_SEC = intEnv('THINK_MAX_SEC', 10);
const BROWSE_RPS = intEnv('BROWSE_RPS', 0);
const BROWSE_DURATION = strEnv('BROWSE_DURATION', '8m');
const REJOIN_AFTER_SEC = 60;
const POLL = 'GET /api/waiting-room/:id/status';
const JOIN = 'POST /api/waiting-room/:id/join';
// 1 seat 25%, 2 seats 55%, 3 seats 20% (a fan buys at most 3 seats per order; the test concert's max per order is 3).
const QTY_WEIGHTS = [
  [1, 0.25],
  [2, 0.55],
  [3, 0.2],
];

if (FAN_OFFSET + FANS > FAN_COUNT) throw new Error(`need ${FAN_OFFSET + FANS} fans, tokens file has ${FAN_COUNT}`);

const fansBought = new Counter('fans_bought');
const seatsBought = new Counter('seats_bought');
const outcomes = new Counter('fan_outcomes');
const holdConflicts = new Counter('hold_conflicts');
const declines = new Counter('payments_declined');
const throttled = new Counter('throttled_429');
const serverErrors = new Counter('server_errors');
const timeToAdmit = new Trend('time_to_admit_s');
const timeToOrder = new Trend('time_to_order_s');

const scenarios = {
  fans: { executor: 'per-vu-iterations', exec: 'fanJourney', vus: FANS, iterations: 1, maxDuration: '30m' },
};
if (BROWSE_RPS > 0) {
  scenarios.browse = {
    executor: 'constant-arrival-rate',
    exec: 'browse',
    rate: BROWSE_RPS,
    timeUnit: '1s',
    duration: BROWSE_DURATION,
    preAllocatedVUs: Math.max(10, BROWSE_RPS * 2),
    maxVUs: Math.max(50, BROWSE_RPS * 10),
  };
}

export const options = {
  scenarios,
  setupTimeout: '2m',
  teardownTimeout: '2m',
  // Reported, not judged by k6 (the wrapper's report applies the pass criteria). A threshold per endpoint is what
  // makes k6 keep its own latency submetric for the summary.
  thresholds: {
    server_errors: ['count>=0'],
    ...Object.fromEntries(
      [POLL, JOIN, 'GET /api/checkout/concerts/:id/seats', 'POST /api/checkout/holds', 'POST /api/checkout/holds/:id/confirm'].map(
        (n) => [`http_req_duration{name:${n}}`, ['p(95)>=0']],
      ),
    ),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const concertId = requireConcertId();
  const concert = json(call('GET', `/api/concerts/${concertId}`, { tags: { name: 'setup' } }));
  if (!concert) throw new Error(`concert ${concertId} not found`);
  return { concertId, title: concert.title, t0: Date.now() + 3000, browse: BROWSE_RPS > 0 ? browseSetup() : null };
}

const rand = (min, max) => min + Math.random() * (max - min);
const think = () => sleep(rand(THINK_MIN_SEC, THINK_MAX_SEC));

function sampleQty() {
  let r = Math.random();
  for (const [q, w] of QTY_WEIGHTS) {
    if ((r -= w) <= 0) return q;
  }
  return 2;
}

/** A request that keeps going through 429s the way the page would (or with backoff); counts 429s and 5xx. */
function req(me, method, path, name, expected, { body, waitOn429 = 2 } = {}) {
  for (let i = 0; ; i++) {
    const res = call(method, path, {
      headers: me ? me.headers : {},
      body,
      tags: { name },
      expected: [...expected, 429],
    });
    if (res.status === 0 || res.status >= 500) serverErrors.add(1, { name, status: String(res.status) });
    if (res.status !== 429 || i >= 20) return res;
    throttled.add(1, { name });
    me && me.stats && me.stats.throttled++;
    const retryAfter = Number(res.headers['Retry-After']);
    const wait = BACKOFF
      ? Math.min(30, (Number.isFinite(retryAfter) ? retryAfter : 1) * 2 ** i) * rand(0.5, 1.5)
      : waitOn429;
    sleep(wait);
  }
}

/** Joins and polls until admitted. Returns { admitted, position, admittedAt } or { admitted: false, reason }. */
function queue(me, concertId, arrivedAt) {
  const join = () => req(me, 'POST', `/api/waiting-room/${concertId}/join`, JOIN, [200, 202]);
  const j = join();
  if (j.status !== 200 && j.status !== 202) return { admitted: false, reason: `join ${j.status} ${errorCode(j) || ''}` };
  let lastJoin = Date.now();
  let position = null;
  while (Date.now() - arrivedAt < ADMIT_TIMEOUT_SEC * 1000) {
    const s = req(me, 'GET', `/api/waiting-room/${concertId}/status`, POLL, [200], { waitOn429: POLL_SEC });
    const body = json(s) || {};
    if (body.position != null) position = body.position;
    if (body.state === 'admitted') return { admitted: true, position, admittedAt: Date.now() };
    if (body.state === 'expired' || (body.state === 'pending' && Date.now() - lastJoin > REJOIN_AFTER_SEC * 1000)) {
      join();
      lastJoin = Date.now();
    }
    sleep(POLL_SEC + rand(0, 0.5));
  }
  return { admitted: false, reason: 'timeout', position };
}

/** Free seats in layout order from the checkout seat map. */
function freeSeats(me, concertId) {
  const res = req(me, 'GET', `/api/checkout/concerts/${concertId}/seats`, 'GET /api/checkout/concerts/:id/seats', [200]);
  const body = json(res);
  if (!body || !body.sections) return null;
  const out = [];
  for (const sec of body.sections) for (const row of sec.rows) for (const seat of row.seats) if (seat.status === 'available') out.push(seat.id);
  return out;
}

/** qty seats next to each other in the free list, starting near the front (U^2 bias), so fans collide. */
function pickSeats(free, qty) {
  const start = Math.min(free.length - qty, Math.floor(free.length * Math.random() ** 2));
  return free.slice(Math.max(0, start), Math.max(0, start) + qty);
}

function buy(me, concertId) {
  const wanted = sampleQty();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    me.stats.attempts = attempt;
    const free = freeSeats(me, concertId);
    if (free === null) return { outcome: 'error', reason: 'seat map' };
    if (free.length === 0) return { outcome: 'sold_out' };
    think();
    const seatIds = pickSeats(free, Math.min(wanted, free.length));
    const hold = req(me, 'POST', '/api/checkout/holds', 'POST /api/checkout/holds', [201, 403, 409], { body: { concertId, seatIds } });
    const code = errorCode(hold);
    if (hold.status === 409 && code === 'seats_unavailable') {
      holdConflicts.add(1);
      me.stats.conflicts++;
      continue;
    }
    if (hold.status === 403) return { outcome: 'admission_expired', reason: code };
    if (hold.status !== 201) return { outcome: 'error', reason: `hold ${hold.status} ${code || ''}` };
    const { holdId, seats } = json(hold);

    if (Math.random() < ABANDON_RATE) {
      req(me, 'DELETE', `/api/checkout/holds/${holdId}`, 'DELETE /api/checkout/holds/:id', [200, 204, 404]);
      return { outcome: 'abandoned' };
    }
    think();
    const decline = Math.random() < PAY_FAIL_RATE;
    const pay = req(me, 'POST', `/api/checkout/holds/${holdId}/confirm`, 'POST /api/checkout/holds/:id/confirm', [200, 402, 409], {
      body: { simulatePaymentFailure: decline },
    });
    if (pay.status === 200) return { outcome: 'bought', seats: seats.length };
    if (pay.status === 402) {
      declines.add(1);
      me.stats.declines++;
      continue; // seats were released; the fan picks again
    }
    if (pay.status === 409) continue; // hold expired
    return { outcome: 'error', reason: `confirm ${pay.status} ${errorCode(pay) || ''}` };
  }
  return { outcome: 'gave_up' };
}

export function fanJourney(data) {
  // iterationInTest is 0..FANS-1 within this scenario (VU ids are shared with the browse scenario).
  const index = FAN_OFFSET + exec.scenario.iterationInTest;
  const me = { ...fan(index), stats: { throttled: 0, conflicts: 0, declines: 0, attempts: 0 } };
  // Front-loaded wave: arrival = ARRIVAL_SEC * U^2 (half the fans in the first quarter of the window).
  const arrivalAt = data.t0 + ARRIVAL_SEC * 1000 * Math.random() ** 2;
  const wait = arrivalAt - Date.now();
  if (wait > 0) sleep(wait / 1000);
  const arrivedAt = Date.now();

  req(me, 'GET', `/api/concerts/${data.concertId}`, 'GET /api/concerts/:id', [200]);
  const q = queue(me, data.concertId, arrivedAt);
  let result;
  if (!q.admitted) {
    result = { outcome: q.reason === 'timeout' ? 'not_admitted' : 'error', reason: q.reason };
  } else {
    timeToAdmit.add((q.admittedAt - arrivedAt) / 1000);
    result = buy(me, data.concertId);
  }
  if (result.outcome === 'bought') {
    fansBought.add(1);
    seatsBought.add(result.seats);
    timeToOrder.add((Date.now() - arrivedAt) / 1000);
  }
  outcomes.add(1, { outcome: result.outcome });
  console.log(
    'FANRESULT ' +
      JSON.stringify({
        fan: index,
        outcome: result.outcome,
        reason: result.reason || null,
        seats: result.seats || 0,
        position: q.position ?? null,
        arrivedAt: new Date(arrivedAt).toISOString(),
        admittedAt: q.admittedAt ? new Date(q.admittedAt).toISOString() : null,
        finishedAt: new Date().toISOString(),
        timeToAdmitSec: q.admittedAt ? round((q.admittedAt - arrivedAt) / 1000) : null,
        timeToOrderSec: result.outcome === 'bought' ? round((Date.now() - arrivedAt) / 1000) : null,
        ...me.stats,
      }),
  );
}

export function browse(data) {
  const res = browseOnce(data.browse, { scenario: 'browse' }, [200, 429]);
  if (res.status === 429) throttled.add(1, { name: 'browse' });
  if (res.status === 0 || res.status >= 500) serverErrors.add(1, { name: 'browse', status: String(res.status) });
}

export function teardown(data) {
  sleep(2);
  const seats = seatMap(data.concertId);
  const count = (st) => seats.filter((s) => s.status === st).length;
  console.log(
    'SEATRESULT ' + JSON.stringify({ total: seats.length, sold: count('sold'), held: count('held'), available: count('available') }),
  );
}

export function handleSummary(data) {
  const s = data.setup_data;
  if (!s) return { stdout: 'setup failed (see the error above)\n' };
  const v = (name, stat = 'count') => metric(data, name, stat) || 0;
  const p = (name) => [round(metric(data, name, 'med')), round(metric(data, name, 'p(95)')), round(metric(data, name, 'max'))];
  const lat = (name) => round(metric(data, `http_req_duration{name:${name}}`, 'p(95)'));
  const result = {
    concertId: s.concertId,
    fans: FANS,
    fanOffset: FAN_OFFSET,
    settings: { ARRIVAL_SEC, POLL_SEC, BACKOFF, MAX_ATTEMPTS, PAY_FAIL_RATE, ABANDON_RATE, BROWSE_RPS, BROWSE_DURATION },
    fansBought: v('fans_bought'),
    seatsBought: v('seats_bought'),
    holdConflicts: v('hold_conflicts'),
    paymentsDeclined: v('payments_declined'),
    throttled429: v('throttled_429'),
    serverErrors: v('server_errors'),
    timeToAdmitSec: p('time_to_admit_s'),
    timeToOrderSec: p('time_to_order_s'),
    p95Ms: {
      status: lat(POLL),
      join: lat(JOIN),
      seatMap: lat('GET /api/checkout/concerts/:id/seats'),
      hold: lat('POST /api/checkout/holds'),
      confirm: lat('POST /api/checkout/holds/:id/confirm'),
    },
    requests: v('http_reqs'),
  };
  const md = [
    table(
      ['Fans', 'Bought', 'Seats bought', 'Lost seat races (409)', 'Declined payments', '429 (throttled)', '5xx'],
      [[FANS, result.fansBought, result.seatsBought, result.holdConflicts, result.paymentsDeclined, result.throttled429, result.serverErrors]],
    ),
    '',
    table(
      ['Time (s)', 'median', 'p95', 'max'],
      [
        ['arrival → admitted', ...result.timeToAdmitSec],
        ['arrival → order confirmed', ...result.timeToOrderSec],
      ],
    ),
    '',
    table(
      ['p95 ms', 'status poll', 'join', 'seat map', 'hold', 'pay'],
      [['', result.p95Ms.status, result.p95Ms.join, result.p95Ms.seatMap, result.p95Ms.hold, result.p95Ms.confirm]],
    ),
    '',
    `Concert \`${s.concertId}\` (${s.title}). ${result.requests} requests in total. Per-fan outcomes, fairness and the AWS-side evidence are in the flash-sale report written by scripts/flash-sale.sh.`,
  ].join('\n');
  return writeResults('flash-sale-k6', data, result, md);
}
