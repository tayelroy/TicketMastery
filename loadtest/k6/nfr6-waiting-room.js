// NFR-6: the waiting room admits fans in arrival order.
// Creates a fresh concert whose sale opens SALE_OPENS_IN seconds from now, has FANS fans join one after another in a
// known order (before the sale opens, so they all queue), then polls their status until every fan is admitted.
// Checks: queue position = join order, and no fan is admitted by an earlier admit run than someone who joined
// before them (each admit run stamps its batch with the same admittedUntil).
//
//   FANS=20 FAN_OFFSET=0 SALE_OPENS_IN=120 JOIN_GAP_MS=200 POLL=5 TIMEOUT=900  k6 run k6/nfr6-waiting-room.js
import { sleep } from 'k6';
import http from 'k6/http';
import { call, createLoadTestConcert, json } from './lib/api.js';
import { BASE_URL, fan, intEnv } from './lib/config.js';
import { stamp, table, writeResults } from './lib/summary.js';

const FANS = intEnv('FANS', 20);
const FAN_OFFSET = intEnv('FAN_OFFSET', 0);
const SALE_OPENS_IN = intEnv('SALE_OPENS_IN', 120);
const JOIN_GAP_MS = intEnv('JOIN_GAP_MS', 200);
const POLL = intEnv('POLL', 5);
const TIMEOUT = intEnv('TIMEOUT', 900);

export const options = {
  scenarios: { setup_only: { executor: 'shared-iterations', vus: 1, iterations: 1 } },
  setupTimeout: `${TIMEOUT + SALE_OPENS_IN + 120}s`,
};

function countInversions(values) {
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) if (values[i] !== null && values[j] !== null && values[j] < values[i]) n++;
  }
  return n;
}

export function setup() {
  const concert = createLoadTestConcert({ seats: 50, saleOpensInSec: SALE_OPENS_IN, title: `Waiting-room order ${stamp()}`, waitForSale: false });
  const concertId = concert.concertId;

  const fans = [];
  for (let k = 0; k < FANS; k++) {
    const f = fan(FAN_OFFSET + k);
    const joinedAt = new Date().toISOString();
    const res = call('POST', `/api/waiting-room/${concertId}/join`, {
      headers: f.headers,
      tags: { name: 'POST /api/waiting-room/:id/join' },
      expected: [200, 202, 501],
    });
    if (res.status === 501) return { concertId, skipped: 'waiting room not configured on this API (501)' };
    if (res.status !== 200 && res.status !== 202) throw new Error(`join #${k + 1}: HTTP ${res.status} ${res.body}`);
    fans.push({ joinOrder: k + 1, fanId: f.id, index: FAN_OFFSET + k, joinedAt, position: null, admittedUntil: null, admittedSeenAt: null });
    sleep(JOIN_GAP_MS / 1000);
  }
  console.log(`${FANS} fans joined in order; sale opens ${concert.saleStartsAt}`);

  const started = Date.now();
  let open = fans.slice();
  while (open.length > 0 && Date.now() - started < TIMEOUT * 1000) {
    const res = http.batch(
      open.map((f) => ({
        method: 'GET',
        url: `${BASE_URL}/api/waiting-room/${concertId}/status`,
        params: { headers: fan(f.index).headers, tags: { name: 'GET /api/waiting-room/:id/status' } },
      })),
    );
    const now = new Date().toISOString();
    res.forEach((r, k) => {
      const body = json(r);
      const f = open[k];
      if (!body) return;
      if (body.position !== null && body.position !== undefined) f.position = body.position;
      if (body.state === 'admitted' && !f.admittedSeenAt) {
        f.admittedSeenAt = now;
        f.admittedUntil = body.admittedUntil;
      }
    });
    open = open.filter((f) => !f.admittedSeenAt);
    if (open.length > 0) {
      const waiting = fans.filter((f) => f.position !== null && !f.admittedSeenAt).length;
      console.log(`admitted ${fans.length - open.length}/${fans.length}, numbered and waiting ${waiting}`);
      sleep(POLL);
    }
  }

  // Each admit run gives its whole batch the same admittedUntil, so it identifies the run.
  const runs = [...new Set(fans.filter((f) => f.admittedUntil).map((f) => f.admittedUntil))].sort();
  for (const f of fans) f.admitRun = f.admittedUntil ? runs.indexOf(f.admittedUntil) + 1 : null;

  const positionMismatches = fans.filter((f) => f.position !== f.joinOrder).length;
  const positionInversions = countInversions(fans.map((f) => f.position));
  const admissionInversions = countInversions(fans.map((f) => f.admitRun));
  const notAdmitted = fans.filter((f) => !f.admittedSeenAt).length;
  return {
    concertId,
    saleStartsAt: concert.saleStartsAt,
    fans: FANS,
    admitRuns: runs.length,
    positionMismatches,
    positionInversions,
    admissionInversions,
    notAdmitted,
    pass: notAdmitted === 0 && positionInversions === 0 && admissionInversions === 0,
    order: fans,
  };
}

export default function () {}

export function handleSummary(data) {
  const s = data.setup_data;
  if (!s) return { stdout: 'setup failed (see the error above)\n' };
  if (s.skipped) return writeResults('nfr6-waiting-room', data, s, `Skipped: ${s.skipped}.`);
  const md = [
    table(
      ['Fans joined in order', 'Admit runs observed', 'Position ≠ join order', 'Position inversions', 'Admission-order inversions', 'Not admitted', 'NFR-6'],
      [[s.fans, s.admitRuns, s.positionMismatches, s.positionInversions, s.admissionInversions, s.notAdmitted, s.pass ? 'PASS' : 'FAIL']],
    ),
    '',
    `Concert \`${s.concertId}\`, sale opened ${s.saleStartsAt}. Queue log (join order vs queue position vs admit run):`,
    '',
    table(
      ['Join #', 'Fan', 'Joined at', 'Position', 'Admit run', 'Admitted (first seen)', 'Admitted until'],
      s.order.map((f) => [f.joinOrder, f.fanId, f.joinedAt, f.position, f.admitRun, f.admittedSeenAt, f.admittedUntil]),
    ),
  ].join('\n');
  const { order, ...head } = s;
  return writeResults('nfr6-waiting-room', data, { ...head, order }, md);
}
