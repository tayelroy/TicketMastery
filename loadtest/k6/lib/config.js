// Shared settings for every k6 script. Run k6 from the loadtest/ folder (results/ and state/ are relative to it).
//
//   BASE_URL      API origin, no trailing slash (default http://localhost:3000). Against AWS use the API Gateway URL.
//   AUTH          dev (x-dev-user-* headers, local docker-compose API) | cognito (Bearer tokens from TOKENS_FILE)
//   TOKENS_FILE   path relative to loadtest/k6/lib (default ../../state/tokens.json); written by scripts/cognito-users.sh
//   CONCERT_FILE  path relative to loadtest/k6/lib (default ../../state/concert.json); written by k6/setup-concert.js
//   CONCERT_ID    overrides CONCERT_FILE

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const AUTH = (__ENV.AUTH || 'dev').toLowerCase();
if (AUTH !== 'dev' && AUTH !== 'cognito') throw new Error(`AUTH must be dev or cognito, got ${AUTH}`);

function readJson(path) {
  try {
    return JSON.parse(open(path));
  } catch (e) {
    return null;
  }
}

const tokens = AUTH === 'cognito' ? readJson(__ENV.TOKENS_FILE || '../../state/tokens.json') : null;
if (AUTH === 'cognito' && !tokens) {
  throw new Error('AUTH=cognito needs state/tokens.json: run scripts/cognito-users.sh tokens first');
}

const concertState = readJson(__ENV.CONCERT_FILE || '../../state/concert.json');

/** Load-test concert id: CONCERT_ID, else state/concert.json, else null. */
export const CONCERT_ID = __ENV.CONCERT_ID || (concertState && concertState.concertId) || null;

export function requireConcertId() {
  if (!CONCERT_ID) throw new Error('No concert: run k6/setup-concert.js first or set CONCERT_ID');
  return CONCERT_ID;
}

/** Fans available to the test: tokens.json in cognito mode; unlimited synthetic ids in dev mode. */
export const FAN_COUNT = tokens ? tokens.fans.length : Number.MAX_SAFE_INTEGER;

/** The tokens file's creation time, so a summary can warn when the 60-minute access tokens may have run out. */
export const TOKENS_CREATED_AT = tokens ? tokens.createdAt : null;

const pad = (n) => String(n).padStart(3, '0');

/** A fan by zero-based index: { id, headers }. */
export function fan(index) {
  if (AUTH === 'dev') {
    return { id: `lt-fan-${pad(index + 1)}`, headers: { 'x-dev-user-id': `lt-fan-${pad(index + 1)}` } };
  }
  const f = tokens.fans[index];
  if (!f) throw new Error(`tokens.json has ${tokens.fans.length} fans; fan #${index} requested (create more users)`);
  return { id: f.sub || f.email, headers: { Authorization: `Bearer ${f.accessToken}` } };
}

/** The organiser (group organisers). */
export function organiser() {
  if (AUTH === 'dev') {
    return { id: 'lt-organiser', headers: { 'x-dev-user-id': 'lt-organiser', 'x-dev-user-groups': 'organisers' } };
  }
  if (!tokens.organiser) throw new Error('tokens.json has no organiser');
  return { id: tokens.organiser.sub, headers: { Authorization: `Bearer ${tokens.organiser.accessToken}` } };
}

export function intEnv(name, fallback) {
  const v = __ENV[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${v}`);
  return n;
}

export function strEnv(name, fallback) {
  const v = __ENV[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Warning text when BASE_URL is the CloudFront URL and the planned rate exceeds the WAF rule; null otherwise. */
export function wafWarning(totalRequests, windowSeconds) {
  if (!/cloudfront\.net/.test(BASE_URL)) return null;
  const per5min = (totalRequests / windowSeconds) * 300;
  if (per5min <= 2000) return null;
  return (
    `BASE_URL is CloudFront: about ${Math.round(per5min)} requests / 5 min from this IP exceeds the WAF rate rule ` +
    '(2000 / 5 min / IP); expect 403s after the limit (this shows the WAF working, not API latency). ' +
    'Use the API Gateway URL for latency numbers.'
  );
}
