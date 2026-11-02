// NFR-4: an expired hold is released (seat available again within 30 s of expiry).
// Fan A holds one free seat (10-minute hold) and walks away. From 20 s before `expiresAt` the public seat map is
// polled every POLL seconds until the seat shows `available`; then fan B holds the same seat (proving it can really
// be sold again) and releases it, and fan A's late payment must be refused with `hold_expired`.
// Takes about 11 minutes. Fans FAN_OFFSET and FAN_OFFSET+1 must be admitted for at least 12 more minutes (in AWS use
// two fans not admitted by setup-concert, so their 15-minute admission starts now).
//
//   FAN_OFFSET=0 POLL=2  k6 run k6/nfr4-hold-expiry.js
import { sleep } from 'k6';
import { call, ensureAdmitted, errorCode, json, seatMap } from './lib/api.js';
import { fan, intEnv, requireConcertId } from './lib/config.js';
import { round, table, writeResults } from './lib/summary.js';

const FAN_OFFSET = intEnv('FAN_OFFSET', 0);
const POLL = intEnv('POLL', 2);
const TARGET_SEC = 30;

export const options = {
  scenarios: { setup_only: { executor: 'shared-iterations', vus: 1, iterations: 1 } },
  setupTimeout: '25m',
};

const sleepUntil = (ms) => {
  const wait = ms - Date.now();
  if (wait > 0) sleep(wait / 1000);
};

function seatStatus(concertId, seatId) {
  const s = seatMap(concertId).find((x) => x.id === seatId);
  return s ? s.status : null;
}

export function setup() {
  const concertId = requireConcertId();
  const a = fan(FAN_OFFSET);
  const b = fan(FAN_OFFSET + 1);
  const admission = ensureAdmitted([FAN_OFFSET, FAN_OFFSET + 1], concertId, { timeoutSec: 600, minRemainingSec: 12 * 60 });

  const free = seatMap(concertId).filter((s) => s.status === 'available');
  if (free.length === 0) throw new Error('no free seat left on the concert');
  const seat = free[free.length - 1]; // the far end of the layout, away from the NFR-3 pool

  const hold = call('POST', '/api/checkout/holds', {
    headers: a.headers,
    body: { concertId, seatIds: [seat.id] },
    tags: { name: 'POST /api/checkout/holds' },
  });
  if (hold.status !== 201) throw new Error(`fan A hold: HTTP ${hold.status} ${hold.body}`);
  const h = json(hold);
  const expiresAtMs = Date.parse(h.expiresAt);
  console.log(`fan A holds ${seat.label} until ${h.expiresAt}; waiting ${Math.round((expiresAtMs - Date.now()) / 1000)}s`);

  sleepUntil(expiresAtMs - 20_000);
  const statusBeforeExpiry = seatStatus(concertId, seat.id);

  let availableAtMs = null;
  const polls = [];
  while (Date.now() < expiresAtMs + 10 * 60_000) {
    const status = seatStatus(concertId, seat.id);
    const t = Date.now();
    polls.push({ at: new Date(t).toISOString(), status });
    if (status === 'available' && t >= expiresAtMs) {
      availableAtMs = t;
      break;
    }
    sleep(POLL);
  }

  let reHold = null;
  if (availableAtMs) {
    const r = call('POST', '/api/checkout/holds', {
      headers: b.headers,
      body: { concertId, seatIds: [seat.id] },
      tags: { name: 'POST /api/checkout/holds' },
      expected: [201, 409],
    });
    reHold = { status: r.status, at: new Date().toISOString(), code: errorCode(r) };
    if (r.status === 201) {
      call('DELETE', `/api/checkout/holds/${json(r).holdId}`, { headers: b.headers, tags: { name: 'DELETE /api/checkout/holds/:id' } });
    }
  }

  const late = call('POST', `/api/checkout/holds/${h.holdId}/confirm`, {
    headers: a.headers,
    body: {},
    tags: { name: 'POST /api/checkout/holds/:id/confirm' },
    expected: [200, 409],
  });

  const availableAfterSec = availableAtMs ? round((availableAtMs - expiresAtMs) / 1000) : null;
  const reHoldAfterSec = reHold ? round((Date.parse(reHold.at) - expiresAtMs) / 1000) : null;
  return {
    concertId,
    admission,
    seat: seat.label,
    seatId: seat.id,
    holdId: h.holdId,
    heldAt: new Date(expiresAtMs - 10 * 60_000).toISOString(),
    expiresAt: h.expiresAt,
    statusBeforeExpiry,
    availableAt: availableAtMs ? new Date(availableAtMs).toISOString() : null,
    availableAfterSec,
    pollIntervalSec: POLL,
    reHold,
    reHoldAfterSec,
    lateConfirm: { status: late.status, code: errorCode(late) },
    pass:
      statusBeforeExpiry === 'held' &&
      availableAfterSec !== null &&
      availableAfterSec <= TARGET_SEC &&
      reHold !== null &&
      reHold.status === 201 &&
      late.status === 409 &&
      errorCode(late) === 'hold_expired',
    polls,
  };
}

export default function () {}

export function handleSummary(data) {
  const s = data.setup_data;
  if (!s) return { stdout: 'setup failed (see the error above)\n' };
  const md = [
    table(
      ['Seat', 'Hold expires at', 'Seat map 20 s before', 'Available again at', 'Seconds after expiry', 'Fan B re-hold', 'Fan A late payment', 'NFR-4 (≤ 30 s)'],
      [[
        s.seat,
        s.expiresAt,
        s.statusBeforeExpiry,
        s.availableAt,
        s.availableAfterSec,
        s.reHold ? `HTTP ${s.reHold.status} at +${s.reHoldAfterSec} s` : 'not attempted',
        `HTTP ${s.lateConfirm.status} ${s.lateConfirm.code || ''}`,
        s.pass ? 'PASS' : 'FAIL',
      ]],
    ),
    '',
    `Concert \`${s.concertId}\`, seat map polled every ${s.pollIntervalSec} s (so the measured delay is accurate to about ${s.pollIntervalSec} s).`,
  ].join('\n');
  return writeResults('nfr4-hold-expiry', data, s, md);
}
