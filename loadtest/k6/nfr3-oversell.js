// NFR-3: no seat is sold twice. FANS signed-in fans start at the same instant and race for a small pool of POOL seats:
// each picks SEATS_PER_HOLD random seats from the pool, holds them (POST /api/checkout/holds) and pays
// (POST /api/checkout/holds/:holdId/confirm). A fan who loses a race reloads the seat map and tries the pool seats
// still free, up to MAX_ATTEMPTS. PAY_FAIL_RATE of payments are simulated failures, which release the seats so others
// can buy them (churn on the same rows). Afterwards the pool's sold count from the seat map must equal the seats
// confirmed to fans; the authoritative check is scripts/nfr3-oversell-check.sh (SQL inside the VPC).
//
//   FANS=50 FAN_OFFSET=0 POOL=20 SEATS_PER_HOLD=2 MAX_ATTEMPTS=5 PAY_FAIL_RATE=0.1  k6 run k6/nfr3-oversell.js
import { sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Gauge } from 'k6/metrics';
import { call, ensureAdmitted, errorCode, json, range, seatMap } from './lib/api.js';
import { FAN_COUNT, fan, intEnv, requireConcertId } from './lib/config.js';
import { metric, table, writeResults } from './lib/summary.js';

const FANS = intEnv('FANS', 50);
const FAN_OFFSET = intEnv('FAN_OFFSET', 0);
const POOL = intEnv('POOL', 20);
const SEATS_PER_HOLD = intEnv('SEATS_PER_HOLD', 2);
const MAX_ATTEMPTS = intEnv('MAX_ATTEMPTS', 5);
const PAY_FAIL_RATE = intEnv('PAY_FAIL_RATE', 0.1);
const THINK_MAX_SEC = intEnv('THINK_MAX_SEC', 2);
const START_DELAY = intEnv('START_DELAY', 10);

if (FAN_OFFSET + FANS > FAN_COUNT) throw new Error(`need ${FAN_OFFSET + FANS} fans, tokens file has ${FAN_COUNT}`);

const holdAttempts = new Counter('hold_attempts');
const holdsOk = new Counter('holds_ok');
const holdConflicts = new Counter('hold_conflicts');
const holdOther = new Counter('hold_other_errors');
const ordersConfirmed = new Counter('orders_confirmed');
const seatsConfirmed = new Counter('seats_confirmed');
const paymentsFailed = new Counter('payments_failed');
const confirmOther = new Counter('confirm_other_errors');
const serverErrors = new Counter('server_errors');
const poolSold = new Gauge('pool_seats_sold');
const poolHeld = new Gauge('pool_seats_still_held');

export const options = {
  scenarios: {
    race: { executor: 'per-vu-iterations', vus: FANS, iterations: 1, maxDuration: '10m' },
  },
  setupTimeout: '15m',
  thresholds: {
    server_errors: ['count==0'],
    'http_req_duration{name:POST /api/checkout/holds}': ['p(95)>=0'], // reported, not judged
    holds_ok: ['count>0'],
  },
};

export function setup() {
  const concertId = requireConcertId();
  const admission = ensureAdmitted(range(FAN_OFFSET, FANS), concertId, { timeoutSec: 600, minRemainingSec: 300 });
  const free = seatMap(concertId).filter((s) => s.status === 'available');
  if (free.length < POOL) throw new Error(`concert ${concertId} has only ${free.length} free seats; POOL=${POOL}`);
  const pool = free.slice(0, POOL);
  return { concertId, admission, pool: pool.map((s) => s.id), poolLabels: pool.map((s) => s.label), startAt: Date.now() + START_DELAY * 1000 };
}

function pick(ids, n) {
  const copy = ids.slice();
  const out = [];
  while (out.length < n && copy.length > 0) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}

function track(res) {
  if (res.status === 0 || res.status >= 500) serverErrors.add(1, { status: String(res.status) });
}

export default function (data) {
  const me = fan(FAN_OFFSET + exec.vu.idInTest - 1);
  const wait = data.startAt - Date.now();
  if (wait > 0) sleep(wait / 1000);

  let candidates = data.pool;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const seatIds = pick(candidates, SEATS_PER_HOLD);
    holdAttempts.add(1);
    const hold = call('POST', '/api/checkout/holds', {
      headers: me.headers,
      body: { concertId: data.concertId, seatIds },
      tags: { name: 'POST /api/checkout/holds' },
      expected: [201, 409],
    });
    track(hold);

    if (hold.status === 201) {
      holdsOk.add(1);
      const { holdId, seats } = json(hold);
      sleep(Math.random() * THINK_MAX_SEC);
      const fail = Math.random() < PAY_FAIL_RATE;
      const confirm = call('POST', `/api/checkout/holds/${holdId}/confirm`, {
        headers: me.headers,
        body: { simulatePaymentFailure: fail },
        tags: { name: 'POST /api/checkout/holds/:id/confirm' },
        expected: [200, 402],
      });
      track(confirm);
      if (confirm.status === 200) {
        ordersConfirmed.add(1);
        seatsConfirmed.add(seats.length);
      } else if (confirm.status === 402) {
        paymentsFailed.add(1);
      } else {
        confirmOther.add(1, { code: String(errorCode(confirm) || confirm.status) });
      }
      return;
    }

    if (hold.status === 409 && errorCode(hold) === 'seats_unavailable') {
      holdConflicts.add(1);
      const left = new Set(data.pool);
      const free = seatMap(data.concertId).filter((s) => left.has(s.id) && s.status === 'available').map((s) => s.id);
      if (free.length === 0) return; // pool sold out
      candidates = free;
      continue;
    }

    holdOther.add(1, { code: String(errorCode(hold) || hold.status) });
    return;
  }
}

export function teardown(data) {
  // Let any still-running confirm finish committing before reading the final state.
  sleep(2);
  const inPool = new Set(data.pool);
  const seats = seatMap(data.concertId).filter((s) => inPool.has(s.id));
  poolSold.add(seats.filter((s) => s.status === 'sold').length);
  poolHeld.add(seats.filter((s) => s.status === 'held').length);
}

export function handleSummary(data) {
  const s = data.setup_data;
  if (!s) return { stdout: 'setup failed (see the error above)\n' };
  const v = (name, stat = 'count') => metric(data, name, stat) || 0;
  const result = {
    concertId: s.concertId,
    fans: FANS,
    pool: POOL,
    seatsPerHold: SEATS_PER_HOLD,
    payFailRate: PAY_FAIL_RATE,
    admission: s.admission,
    holdAttempts: v('hold_attempts'),
    holdsOk: v('holds_ok'),
    holdConflicts: v('hold_conflicts'),
    holdOtherErrors: v('hold_other_errors'),
    ordersConfirmed: v('orders_confirmed'),
    seatsConfirmed: v('seats_confirmed'),
    paymentsFailed: v('payments_failed'),
    confirmOtherErrors: v('confirm_other_errors'),
    serverErrors: v('server_errors'),
    poolSeatsSold: v('pool_seats_sold', 'value'),
    poolSeatsStillHeld: v('pool_seats_still_held', 'value'),
    holdP95Ms: metric(data, 'http_req_duration{name:POST /api/checkout/holds}', 'p(95)'),
    poolSeats: s.poolLabels,
  };
  // If any seat had been confirmed to two fans, fans would hold more confirmed seats than the pool shows as sold.
  result.apiOversold = result.seatsConfirmed - result.poolSeatsSold;
  result.pass = result.apiOversold === 0 && result.poolSeatsSold <= POOL && result.serverErrors === 0;
  const md = [
    table(
      ['Fans', 'Contested seats', 'Hold attempts', 'Successful holds', 'Lost races (409)', 'Paid orders', 'Seats paid for', 'Payment failures', 'Pool seats sold (seat map)', 'Oversold (API view)', '5xx'],
      [[FANS, POOL, result.holdAttempts, result.holdsOk, result.holdConflicts, result.ordersConfirmed, result.seatsConfirmed, result.paymentsFailed, result.poolSeatsSold, result.apiOversold, result.serverErrors]],
    ),
    '',
    `Concert \`${s.concertId}\`. API-level result: ${result.pass ? 'PASS' : 'FAIL'}. Confirm with the SQL check: \`scripts/nfr3-oversell-check.sh ${s.concertId}\`.`,
  ].join('\n');
  return writeResults('nfr3-oversell', data, result, md);
}
