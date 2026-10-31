// LOCAL DRY-RUN ONLY. The docker-compose API answers /api/waiting-room with 501 (no SQS/DynamoDB locally), so this
// stand-in implements the documented contract (services/ticketmastery-api/src/modules/waiting-room/README.md) in
// memory and proxies every other path to the real local API. It lets k6/nfr6-waiting-room.js and the admission
// step of the other scripts be exercised end to end before running them against AWS, where the real waiting room
// (SQS FIFO -> queue-manager -> DynamoDB, admit step once a minute) answers instead.
//
//   UPSTREAM=http://localhost:3000 PORT=3200 ADMIT_EVERY_MS=5000 ADMIT_BATCH=3 node dev/fake-waiting-room.mjs
import http from 'node:http';

const UPSTREAM = process.env.UPSTREAM || 'http://localhost:3000';
const PORT = Number(process.env.PORT || 3200);
const ADMIT_EVERY_MS = Number(process.env.ADMIT_EVERY_MS || 5000);
const ADMIT_BATCH = Number(process.env.ADMIT_BATCH || 3);
const WINDOW_SEC = Number(process.env.ADMISSION_WINDOW_SECONDS || 900);
const ASSIGN_DELAY_MS = 300; // queue-manager assigns the number asynchronously

/** concertId -> { saleStartsAt, last, admittedUpTo, fans: Map<userId, { position?, status, admissionExpiresAt? }> } */
const queues = new Map();
/** concertId -> pending concert lookup, shared by concurrent first joins */
const lookups = new Map();

function status(concertId, q, userId) {
  const e = q?.fans.get(userId);
  const base = { concertId, position: null, peopleAhead: null, admittedUntil: null };
  if (!e || e.position === undefined) return { ...base, state: 'pending' };
  if (e.status === 'ADMITTED') {
    const until = e.admissionExpiresAt * 1000;
    return { ...base, state: Date.now() > until ? 'expired' : 'admitted', position: e.position, peopleAhead: 0, admittedUntil: new Date(until).toISOString() };
  }
  return { ...base, state: 'waiting', position: e.position, peopleAhead: Math.max(0, e.position - 1 - q.admittedUpTo) };
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function queueFor(concertId) {
  if (queues.has(concertId)) return queues.get(concertId);
  if (!lookups.has(concertId)) {
    lookups.set(
      concertId,
      fetch(`${UPSTREAM}/api/concerts/${concertId}`).then(async (r) => {
        lookups.delete(concertId);
        if (!r.ok) return null;
        const q = { saleStartsAt: Date.parse((await r.json()).saleStartsAt), last: 0, admittedUpTo: 0, fans: new Map() };
        queues.set(concertId, q);
        return q;
      }),
    );
  }
  return lookups.get(concertId);
}

async function waitingRoom(req, res, concertId, action) {
  const userId = req.headers['x-dev-user-id'];
  if (!userId) return send(res, 401, { error: { code: 'unauthenticated', message: 'Authentication required' } });
  if (action === 'status') return send(res, 200, status(concertId, queues.get(concertId), userId));

  const q = await queueFor(concertId);
  if (!q) return send(res, 404, { error: { code: 'not_found', message: 'Concert not found' } });
  const current = status(concertId, q, userId);
  if (current.state === 'waiting' || current.state === 'admitted') return send(res, 200, current);
  // Arrival order is fixed now (FIFO); the number becomes visible a moment later.
  const entry = { status: 'WAITING' };
  q.fans.set(userId, entry);
  const position = ++q.last;
  setTimeout(() => (entry.position = position), ASSIGN_DELAY_MS);
  return send(res, 202, { ...current, state: 'pending' });
}

setInterval(() => {
  const now = Date.now();
  for (const q of queues.values()) {
    if (now < q.saleStartsAt) continue;
    const next = [...q.fans.values()]
      .filter((e) => e.status === 'WAITING' && e.position !== undefined)
      .sort((a, b) => a.position - b.position)
      .slice(0, ADMIT_BATCH);
    for (const e of next) {
      e.status = 'ADMITTED';
      e.admissionExpiresAt = Math.floor(now / 1000) + WINDOW_SEC;
      q.admittedUpTo = Math.max(q.admittedUpTo, e.position);
    }
  }
}, ADMIT_EVERY_MS);

function proxy(req, res) {
  const up = http.request(`${UPSTREAM}${req.url}`, { method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => send(res, 502, { error: { code: 'bad_gateway', message: e.message } }));
  req.pipe(up);
}

http
  .createServer((req, res) => {
    const m = req.url.match(/^\/api\/waiting-room\/([0-9a-f-]{36})\/(join|status)(\?.*)?$/);
    if (!m) return proxy(req, res);
    if ((m[2] === 'join' && req.method !== 'POST') || (m[2] === 'status' && req.method !== 'GET')) {
      return send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }
    waitingRoom(req, res, m[1], m[2]).catch((e) => send(res, 500, { error: { code: 'internal', message: e.message } }));
  })
  .listen(PORT, () => console.log(`fake waiting room on :${PORT}, proxying to ${UPSTREAM}; admits ${ADMIT_BATCH} every ${ADMIT_EVERY_MS} ms`));
