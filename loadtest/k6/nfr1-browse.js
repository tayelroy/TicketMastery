// NFR-1: browse and seat-map APIs, p95 < 300 ms and p99 < 800 ms at baseline load.
// Constant arrival rate of RATE requests/s for DURATION, mixed like a browsing fan (lib/browse.js): 30% concert list,
// 40% concert detail, 30% seat map of the load-test concert.
//
//   RATE=10 DURATION=5m  k6 run k6/nfr1-browse.js
// Latency is measured at this client, so it includes the network path to ap-southeast-1; compare with the ALB's
// TargetResponseTime (scripts/alb-metrics.sh) for the server-side share.
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { ENDPOINTS, browseOnce, browseSetup, seconds } from './lib/browse.js';
import { intEnv, strEnv, wafWarning } from './lib/config.js';
import { metric, round, table, writeResults } from './lib/summary.js';

const RATE = intEnv('RATE', 10);
const DURATION = strEnv('DURATION', '5m');
const durationSec = seconds(DURATION);

const wafBlocked = new Counter('waf_403');

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(5, RATE * 2),
      maxVUs: Math.max(50, RATE * 20),
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<300', 'p(99)<800'],
    'http_req_failed{scenario:browse}': ['rate<0.01'],
    ...Object.fromEntries(ENDPOINTS.map((e) => [`http_req_duration{name:${e}}`, ['p(95)>=0']])), // per-endpoint breakdown
  },
};

export function setup() {
  const warning = wafWarning(RATE * durationSec, durationSec);
  if (warning) console.warn(warning);
  return { ...browseSetup(), warning };
}

export default function (data) {
  const res = browseOnce(data);
  if (res.status === 403) wafBlocked.add(1);
  check(res, { 'status 200': (x) => x.status === 200 });
}

export function handleSummary(data) {
  const s = data.setup_data || {};
  const d = (stat, sub = 'scenario:browse') => round(metric(data, `http_req_duration{${sub}}`, stat));
  const requests = metric(data, 'http_req_duration{scenario:browse}', 'count') || 0;
  const result = {
    rateRps: RATE,
    duration: DURATION,
    concertId: s.concertId,
    requests,
    achievedRps: round(requests / durationSec, 2),
    errorRate: round(metric(data, 'http_req_failed{scenario:browse}', 'rate') || 0, 4),
    waf403: metric(data, 'waf_403', 'count') || 0,
    p50Ms: d('med'),
    p95Ms: d('p(95)'),
    p99Ms: d('p(99)'),
    maxMs: d('max'),
    endpoints: Object.fromEntries(
      ENDPOINTS.map((e) => [e, { count: metric(data, `http_req_duration{name:${e}}`, 'count'), p95Ms: d('p(95)', `name:${e}`), p99Ms: d('p(99)', `name:${e}`) }]),
    ),
    wafWarning: s.warning || null,
  };
  result.pass = result.p95Ms !== null && result.p95Ms < 300 && result.p99Ms < 800 && result.errorRate < 0.01;
  const md = [
    table(
      ['Load', 'Requests', 'p50 ms', 'p95 ms', 'p99 ms', 'Max ms', 'Errors', 'NFR-1 (p95 < 300, p99 < 800)'],
      [[`${RATE} req/s for ${DURATION}`, result.requests, result.p50Ms, result.p95Ms, result.p99Ms, result.maxMs, `${round(result.errorRate * 100, 2)}%`, result.pass ? 'PASS' : 'FAIL']],
    ),
    '',
    table(
      ['Endpoint', 'Requests', 'p95 ms', 'p99 ms'],
      ENDPOINTS.map((e) => [e, result.endpoints[e].count, result.endpoints[e].p95Ms, result.endpoints[e].p99Ms]),
    ),
    result.wafWarning ? `\n> ${result.wafWarning} WAF 403s: ${result.waf403}.` : '',
  ].join('\n');
  return writeResults('nfr1-browse', data, result, md);
}
