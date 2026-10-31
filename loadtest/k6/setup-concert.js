// Creates an on-sale load-test concert through the organiser API and (optionally) gets fans through the waiting room
// so their holds are accepted. Writes state/concert.json for the other scripts.
//
//   SEATS=500         seats (one GA ticket type, rows of 50)
//   SALE_OPENS_IN=30  seconds until the sale opens (the API needs a future sale start; we wait for it)
//   ADMIT_FANS=0      fans (from FAN_OFFSET) to join the waiting room and wait for admission (AWS only matters)
//   FAN_OFFSET=0
//
//   k6 run k6/setup-concert.js
import { createLoadTestConcert, ensureAdmitted, range } from './lib/api.js';
import { intEnv, strEnv } from './lib/config.js';
import { stamp, table, writeResults } from './lib/summary.js';

const SEATS = intEnv('SEATS', 500);
const SALE_OPENS_IN = intEnv('SALE_OPENS_IN', 30);
const ADMIT_FANS = intEnv('ADMIT_FANS', 0);
const FAN_OFFSET = intEnv('FAN_OFFSET', 0);

export const options = {
  scenarios: { setup_only: { executor: 'shared-iterations', vus: 1, iterations: 1 } },
  setupTimeout: '15m',
};

export function setup() {
  const concert = createLoadTestConcert({
    seats: SEATS,
    saleOpensInSec: SALE_OPENS_IN,
    title: strEnv('TITLE', `Load test ${stamp()}`),
  });
  const admission = ADMIT_FANS > 0 ? ensureAdmitted(range(FAN_OFFSET, ADMIT_FANS), concert.concertId, { timeoutSec: 600 }) : null;
  return { ...concert, admission, admittedFans: ADMIT_FANS > 0 ? { offset: FAN_OFFSET, count: ADMIT_FANS } : null };
}

export default function () {}

export function handleSummary(data) {
  const s = data.setup_data;
  if (!s) return { stdout: 'setup failed: no concert created (see the error above)\n' };
  const md = table(
    ['Concert', 'Seats', 'Sale opened', 'Fans admitted'],
    [[s.concertId, s.seats, s.saleStartsAt, s.admission ? `${s.admission.admitted} (${s.admission.waitingRoom})` : 'none requested']],
  );
  return writeResults('setup-concert', data, s, md, { 'state/concert.json': `${JSON.stringify(s, null, 2)}\n` });
}
