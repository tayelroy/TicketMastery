import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, organiser, fan } from './config.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** One API call. `expected` is passed to k6 so only unexpected statuses count in http_req_failed. */
export function call(method, path, { body, headers = {}, tags = {}, expected, timeout = '30s' } = {}) {
  const params = { headers: { ...JSON_HEADERS, ...headers }, tags, timeout };
  if (expected) params.responseCallback = http.expectedStatuses(...expected);
  return http.request(method, `${BASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), params);
}

export function json(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function errorCode(res) {
  const b = json(res);
  return (b && b.error && b.error.code) || null;
}

function must(res, what, statuses = [200, 201]) {
  if (!statuses.includes(res.status)) {
    throw new Error(`${what}: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
  }
  return json(res);
}

const sleepUntil = (ms) => {
  const wait = ms - Date.now();
  if (wait > 0) sleep(wait / 1000);
};

/**
 * Creates and publishes a load-test concert through the organiser API (UC5): one ticket type, `seats` seats in rows of
 * 50, sale opening `saleOpensInSec` from now (the API only accepts a future sale start) and running for two days.
 * Returns once the sale is open unless `waitForSale` is false.
 */
export function createLoadTestConcert({ seats, saleOpensInSec, title, waitForSale = true }) {
  const org = organiser();
  const now = Date.now();
  const saleStartsAt = new Date(now + saleOpensInSec * 1000).toISOString();
  const created = must(
    call('POST', '/api/organiser/concerts', {
      headers: org.headers,
      body: {
        title,
        artist: 'TicketMastery Load Test',
        description: 'Created by loadtest/ for NFR evidence; safe to cancel.',
        venueName: 'Load Test Arena',
        venueAddress: '1 Test Street',
        saleStartsAt,
        saleEndsAt: new Date(now + 2 * 86400_000).toISOString(),
        startsAt: new Date(now + 3 * 86400_000).toISOString(),
      },
    }),
    'create concert',
  );
  const concertId = created.id;

  must(
    call('PUT', `/api/organiser/concerts/${concertId}/ticket-types`, {
      headers: org.headers,
      body: { ticketTypes: [{ name: 'GA', priceCents: 5000, quantity: seats, maxPerOrder: 4 }] },
    }),
    'ticket types',
  );

  const rows = [];
  for (let start = 1, r = 1; start <= seats; start += 50, r += 1) {
    rows.push({ label: `R${r}`, ticketTypeName: 'GA', seats: { from: start, to: Math.min(start + 49, seats) } });
  }
  const sections = [];
  for (let i = 0; i < rows.length; i += 200) sections.push({ name: `Block ${sections.length + 1}`, rows: rows.slice(i, i + 200) });
  must(call('PUT', `/api/organiser/concerts/${concertId}/layout`, { headers: org.headers, body: { sections } }), 'layout');
  must(call('POST', `/api/organiser/concerts/${concertId}/publish`, { headers: org.headers }), 'publish');

  console.log(`concert ${concertId} published; ${seats} seats; sale opens ${saleStartsAt}`);
  if (waitForSale) sleepUntil(Date.parse(saleStartsAt) + 1000);
  return { concertId, title, seats, saleStartsAt };
}

/** Public seat map (UC1) flattened to [{ id, status, label }] in layout order. */
export function seatMap(concertId, tags = {}) {
  const body = must(call('GET', `/api/concerts/${concertId}/seats`, { tags: { name: 'GET /api/concerts/:id/seats', ...tags } }), 'seat map');
  const seats = [];
  for (const section of body.sections) {
    for (const row of section.rows) {
      for (const s of row.seats) seats.push({ id: s.id, status: s.status, label: `${row.label}-${s.seatNumber}` });
    }
  }
  return seats;
}

function statusBatch(indexes, concertId) {
  const reqs = indexes.map((i) => ({
    method: 'GET',
    url: `${BASE_URL}/api/waiting-room/${concertId}/status`,
    params: { headers: fan(i).headers, tags: { name: 'GET /api/waiting-room/:id/status' } },
  }));
  return http.batch(reqs).map((res, k) => ({ index: indexes[k], res, body: json(res) }));
}

function joinBatch(indexes, concertId) {
  for (let k = 0; k < indexes.length; k += 25) {
    const chunk = indexes.slice(k, k + 25);
    const res = http.batch(
      chunk.map((i) => ({
        method: 'POST',
        url: `${BASE_URL}/api/waiting-room/${concertId}/join`,
        params: { headers: fan(i).headers, tags: { name: 'POST /api/waiting-room/:id/join' } },
      })),
    );
    res.forEach((r, j) => {
      if (r.status !== 200 && r.status !== 202) throw new Error(`join fan #${chunk[j]}: HTTP ${r.status} ${r.body}`);
    });
  }
}

/**
 * Joins the waiting room (UC3) for each fan index and polls until all are admitted, so checkout accepts their holds.
 * A fan already admitted is left alone; one whose admission expired rejoins, and one still without a number after
 * REJOIN_AFTER_SEC joins again (a join is idempotent). `minRemainingSec` fails fast when an admission would run out
 * before the test needs it. Local dev has no waiting room (`501`): every fan counts as admitted.
 */
const REJOIN_AFTER_SEC = 60;
export function ensureAdmitted(indexes, concertId, { timeoutSec = 300, minRemainingSec = 0, pollSec = 5 } = {}) {
  const probe = call('GET', `/api/waiting-room/${concertId}/status`, { headers: fan(indexes[0]).headers, expected: [200, 501] });
  if (probe.status === 501) {
    console.log('waiting room not configured on this API (501): checkout admits everyone');
    return { waitingRoom: 'disabled (501)', admitted: indexes.length };
  }

  const started = Date.now();
  let lastJoin = 0;
  let pending = indexes.slice();
  const admittedUntil = {};
  while (pending.length > 0) {
    if (Date.now() - started > timeoutSec * 1000) {
      throw new Error(`${pending.length} fans not admitted after ${timeoutSec}s (admit step runs once a minute after the sale opens)`);
    }
    const next = [];
    const toJoin = [];
    for (let k = 0; k < pending.length; k += 50) {
      for (const s of statusBatch(pending.slice(k, k + 50), concertId)) {
        if (s.body && s.body.state === 'admitted') {
          admittedUntil[s.index] = s.body.admittedUntil;
          continue;
        }
        next.push(s.index);
        if (!s.body || s.body.state === 'pending' || s.body.state === 'expired') toJoin.push(s.index);
      }
    }
    if (toJoin.length > 0 && (lastJoin === 0 || Date.now() - lastJoin > REJOIN_AFTER_SEC * 1000)) {
      if (lastJoin !== 0) console.log(`waiting room: ${toJoin.length} fans still without a number, joining again`);
      joinBatch(toJoin, concertId);
      lastJoin = Date.now();
    }
    pending = next;
    if (pending.length > 0) {
      console.log(`waiting room: ${indexes.length - pending.length}/${indexes.length} admitted`);
      sleep(pollSec);
    }
  }

  const earliest = Math.min(...Object.values(admittedUntil).map((t) => (t ? Date.parse(t) : Infinity)));
  const remainingSec = Math.round((earliest - Date.now()) / 1000);
  if (minRemainingSec > 0 && remainingSec < minRemainingSec) {
    throw new Error(
      `earliest admission ends in ${remainingSec}s but the test needs ${minRemainingSec}s: use fans that are not ` +
        'admitted yet (FAN_OFFSET) or wait for their admission to expire, then rerun',
    );
  }
  console.log(`waiting room: all ${indexes.length} fans admitted after ${Math.round((Date.now() - started) / 1000)}s`);
  return { waitingRoom: 'enforced', admitted: indexes.length, admittedAfterSec: Math.round((Date.now() - started) / 1000), earliestAdmissionEndsInSec: remainingSec };
}

export function range(offset, count) {
  return Array.from({ length: count }, (_, i) => offset + i);
}
