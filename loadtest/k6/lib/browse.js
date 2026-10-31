// The browsing fan's request mix shared by NFR-1 (baseline) and NFR-2 (burst): 30% concert list, 40% concert detail,
// 30% seat map of the load-test concert.
import { call, json } from './api.js';
import { requireConcertId } from './config.js';

export const ENDPOINTS = ['GET /api/concerts', 'GET /api/concerts/:id', 'GET /api/concerts/:id/seats'];

/** Load-test concert plus up to 19 other listed concerts for the detail calls. */
export function browseSetup() {
  const concertId = requireConcertId();
  const list = json(call('GET', '/api/concerts?limit=50', { tags: { name: 'setup' } }));
  const others = ((list && list.concerts) || []).map((c) => c.id).filter((id) => id !== concertId);
  return { concertId, ids: [concertId, ...others.slice(0, 19)] };
}

/** One browse request; `expected` lists statuses that don't count as failed (e.g. 429 in the burst test). */
export function browseOnce(data, tags = {}, expected = [200]) {
  const r = Math.random();
  if (r < 0.3) return call('GET', '/api/concerts', { tags: { name: ENDPOINTS[0], ...tags }, expected });
  if (r < 0.7) {
    const id = data.ids[Math.floor(Math.random() * data.ids.length)];
    return call('GET', `/api/concerts/${id}`, { tags: { name: ENDPOINTS[1], ...tags }, expected });
  }
  return call('GET', `/api/concerts/${data.concertId}/seats`, { tags: { name: ENDPOINTS[2], ...tags }, expected });
}

/** "30s" / "5m" / "1h" -> seconds. */
export function seconds(duration) {
  const m = String(duration).match(/^(\d+)(s|m|h)$/);
  if (!m) throw new Error(`duration like 30s, 5m or 1h, got ${duration}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}
