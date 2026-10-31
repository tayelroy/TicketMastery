// NFR-2: absorb a 10x on-sale spike. Ramping arrival rate of browse traffic (lib/browse.js):
//   baseline BASE_RPS for WARM -> ramp to BASE_RPS*MULT over RAMP -> hold for HOLD -> ramp down over RAMP -> COOL.
// 429s are API Gateway throttling (100 rps steady / 200 burst on the stage) shedding load by design, so they are
// counted apart; "dropped" requests are every other failure (timeouts, 5xx, connection errors).
// Results include a per-minute timeline (requests/s, p95, failures, 429s); scripts/nfr2-burst.sh adds the ECS task
// count and ALB metrics for the same minutes.
//
//   BASE_RPS=10 MULT=10 WARM=2m RAMP=1m HOLD=10m COOL=3m  k6 run k6/nfr2-burst.js
import { Counter } from 'k6/metrics';
import { ENDPOINTS, browseOnce, browseSetup, seconds } from './lib/browse.js';
import { intEnv, strEnv, wafWarning } from './lib/config.js';
import { metric, round, table, writeResults } from './lib/summary.js';

const BASE = intEnv('BASE_RPS', 10);
const PEAK = BASE * intEnv('MULT', 10);
const WARM = strEnv('WARM', '2m');
const RAMP = strEnv('RAMP', '1m');
const HOLD = strEnv('HOLD', '10m');
const COOL = strEnv('COOL', '3m');

const PHASES = [
  ['baseline', seconds(WARM)],
  ['ramp-up', seconds(RAMP)],
  ['peak', seconds(HOLD)],
  ['ramp-down', seconds(RAMP)],
  ['cooldown', seconds(COOL)],
];
const TOTAL_SEC = PHASES.reduce((a, [, s]) => a + s, 0);
const MINUTES = Math.ceil(TOTAL_SEC / 60);

const throttled = new Counter('throttled_429');
const dropped = new Counter('dropped_non429');
const wafBlocked = new Counter('waf_403');

function perTag(tag, values) {
  const t = {};
  for (const v of values) {
    t[`http_reqs{${tag}:${v}}`] = ['count>=0'];
    t[`http_req_duration{${tag}:${v}}`] = ['p(95)>=0'];
    t[`throttled_429{${tag}:${v}}`] = ['count>=0'];
    t[`dropped_non429{${tag}:${v}}`] = ['count>=0'];
  }
  return t;
}

export const options = {
  scenarios: {
    burst: {
      executor: 'ramping-arrival-rate',
      startRate: BASE,
      timeUnit: '1s',
      preAllocatedVUs: Math.max(10, PEAK),
      maxVUs: Math.max(100, PEAK * 6),
      stages: [
        { target: BASE, duration: WARM },
        { target: PEAK, duration: RAMP },
        { target: PEAK, duration: HOLD },
        { target: BASE, duration: RAMP },
        { target: BASE, duration: COOL },
      ],
    },
  },
  summaryTrendStats: ['avg', 'med', 'max', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    dropped_non429: ['count==0'],
    ...perTag('phase', PHASES.map(([p]) => p)),
    ...perTag('minute', Array.from({ length: MINUTES }, (_, m) => String(m))),
  },
};

export function setup() {
  const plannedRequests = PHASES.reduce((a, [p, s]) => a + s * (p === 'peak' ? PEAK : p === 'baseline' || p === 'cooldown' ? BASE : (BASE + PEAK) / 2), 0);
  const warning = wafWarning(plannedRequests, TOTAL_SEC);
  if (warning) console.warn(warning);
  return { ...browseSetup(), startedAt: Date.now(), warning };
}

function phaseAt(elapsedSec) {
  let t = 0;
  for (const [p, s] of PHASES) {
    t += s;
    if (elapsedSec < t) return p;
  }
  return 'cooldown';
}

export default function (data) {
  const elapsed = (Date.now() - data.startedAt) / 1000;
  const tags = { phase: phaseAt(elapsed), minute: String(Math.min(MINUTES - 1, Math.floor(elapsed / 60))) };
  const res = browseOnce(data, tags, [200, 429]);
  if (res.status === 429) throttled.add(1, tags);
  else if (res.status === 403) wafBlocked.add(1, tags);
  else if (res.status !== 200) dropped.add(1, { ...tags, status: String(res.status) });
}

export function handleSummary(data) {
  const s = data.setup_data || {};
  const row = (tag, v, seconds_) => {
    const n = metric(data, `http_reqs{${tag}:${v}}`, 'count') || 0;
    return {
      [tag]: v,
      requests: n,
      rps: round(n / seconds_, 1),
      p95Ms: round(metric(data, `http_req_duration{${tag}:${v}}`, 'p(95)')),
      throttled429: metric(data, `throttled_429{${tag}:${v}}`, 'count') || 0,
      droppedNon429: metric(data, `dropped_non429{${tag}:${v}}`, 'count') || 0,
    };
  };
  const phases = PHASES.map(([p, sec]) => ({ ...row('phase', p, sec), seconds: sec }));
  const timeline = Array.from({ length: MINUTES }, (_, m) => {
    const secs = Math.min(60, TOTAL_SEC - m * 60);
    return { ...row('minute', String(m), secs), from: new Date(s.startedAt + m * 60_000).toISOString() };
  });
  const result = {
    baseRps: BASE,
    peakRps: PEAK,
    stages: { WARM, RAMP, HOLD, COOL },
    concertId: s.concertId,
    requests: metric(data, 'http_reqs', 'count'),
    peakMinuteRps: Math.max(...timeline.map((t) => t.rps || 0)),
    p95Ms: round(metric(data, 'http_req_duration', 'p(95)')),
    p99Ms: round(metric(data, 'http_req_duration', 'p(99)')),
    throttled429: metric(data, 'throttled_429', 'count') || 0,
    droppedNon429: metric(data, 'dropped_non429', 'count') || 0,
    waf403: metric(data, 'waf_403', 'count') || 0,
    phases,
    timeline,
    endpoints: ENDPOINTS,
    wafWarning: s.warning || null,
  };
  result.pass = result.droppedNon429 === 0;
  const md = [
    table(
      ['Base → peak', 'Requests', 'Peak minute req/s', 'p95 ms', 'p99 ms', '429 (throttled)', 'Dropped (non-429 errors)', 'NFR-2 dropped = 0'],
      [[`${BASE} → ${PEAK} req/s`, result.requests, result.peakMinuteRps, result.p95Ms, result.p99Ms, result.throttled429, result.droppedNon429, result.pass ? 'PASS' : 'FAIL']],
    ),
    '',
    table(['Phase', 'Seconds', 'Requests', 'req/s', 'p95 ms', '429', 'Dropped'], phases.map((p) => [p.phase, p.seconds, p.requests, p.rps, p.p95Ms, p.throttled429, p.droppedNon429])),
    '',
    'Per minute (merge with the ECS task count from scripts/nfr2-burst.sh):',
    '',
    table(['Minute', 'From (UTC)', 'Requests', 'req/s', 'p95 ms', '429', 'Dropped'], timeline.map((t) => [t.minute, t.from, t.requests, t.rps, t.p95Ms, t.throttled429, t.droppedNon429])),
    result.wafWarning ? `\n> ${result.wafWarning} WAF 403s: ${result.waf403}.` : '',
  ].join('\n');
  return writeResults('nfr2-burst', data, result, md);
}
