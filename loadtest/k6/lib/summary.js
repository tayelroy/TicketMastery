// Writes results/<test>-<UTC timestamp>.json and .md from handleSummary and echoes the markdown to stdout.
import { BASE_URL, AUTH } from './config.js';

const RESULTS_DIR = (__ENV.RESULTS_DIR || 'results').replace(/\/+$/, '');

export function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** A metric value from the k6 summary data, or null (e.g. a counter that never fired). */
export function metric(data, name, stat) {
  const m = data.metrics[name];
  if (!m || !m.values) return null;
  const v = m.values[stat];
  return v === undefined ? null : v;
}

export const round = (v, digits = 1) => (v === null || v === undefined ? null : Number(v.toFixed(digits)));

export function table(headers, rows) {
  const line = (cells) => `| ${cells.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/**
 * @param test      short name, e.g. "nfr1-browse"
 * @param data      k6 summary data
 * @param result    JSON-serialisable result object (the evidence)
 * @param markdown  report-ready markdown body
 * @param extra     additional { path: content } files (e.g. state/concert.json)
 */
export function writeResults(test, data, result, markdown, extra = {}) {
  const ts = stamp();
  const startedAt = new Date(Date.now() - data.state.testRunDurationMs).toISOString();
  const doc = {
    test,
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    auth: AUTH,
    ...result,
  };
  const md = `# ${test} (${doc.startedAt} to ${doc.finishedAt})\n\nTarget: \`${BASE_URL}\` (AUTH=${AUTH})\n\n${markdown}\n`;
  return {
    stdout: `\n${md}\nWritten: ${RESULTS_DIR}/${test}-${ts}.json and .md\n`,
    [`${RESULTS_DIR}/${test}-${ts}.json`]: `${JSON.stringify(doc, null, 2)}\n`,
    [`${RESULTS_DIR}/${test}-${ts}.md`]: md,
    ...extra,
  };
}
