import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorNotice } from './ErrorNotice';
import { CSV_SECTIONS, csvFilename, type ReportSection } from './reportCsv';
import {
  formatDateTime,
  formatPrice,
  STATUS_LABELS,
  type OrganiserConcert,
  type ReportDays,
  type SalesReport,
} from './types';
import './organiser.css';

type State = { kind: 'loading' } | { kind: 'ready'; report: SalesReport } | { kind: 'error'; error: unknown };

const RANGES: { days: ReportDays; label: string }[] = [
  { days: '7', label: 'Last 7 days' },
  { days: '30', label: '30 days' },
  { days: '90', label: '90 days' },
  { days: 'all', label: 'All time' },
];

/** Sales reports across the organiser's concerts. URL: /organiser/reports?days=30&concert=<id>. */
export function OrganiserReportsPage() {
  const [params, setParams] = useSearchParams();
  const days = RANGES.find((r) => r.days === params.get('days'))?.days ?? '30';
  const concertId = params.get('concert') ?? '';
  const [concerts, setConcerts] = useState<OrganiserConcert[]>([]);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api<{ concerts: OrganiserConcert[] }>('/api/organiser/concerts')
      .then((r) => !cancelled && setConcerts(r.concerts))
      // The select then only offers "All concerts"; the report itself shows any real problem.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const query = new URLSearchParams({ days });
    if (concertId) query.set('concertId', concertId);
    api<SalesReport>(`/api/reports/sales?${query}`)
      .then((report) => !cancelled && setState({ kind: 'ready', report }))
      .catch((error) => !cancelled && setState({ kind: 'error', error }));
    return () => {
      cancelled = true;
    };
  }, [days, concertId]);

  const setParam = (key: 'days' | 'concert', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <Link to="/organiser" className="org-back">
        ‹ My concerts
      </Link>
      <div className="section-head org-head">
        <div>
          <p className="eyebrow">Organiser</p>
          <h1>Sales reports</h1>
        </div>
      </div>

      <section className="card org-panel org-report-controls">
        <div className="org-segmented" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className="small"
              aria-pressed={r.days === days}
              onClick={() => setParam('days', r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className="org-report-concert">
          <span className="muted small">Concert</span>
          <select value={concertId} onChange={(e) => setParam('concert', e.target.value)}>
            <option value="">All concerts</option>
            {concerts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      </section>

      {state.kind === 'loading' && <p className="muted org-report-note">Loading…</p>}
      {state.kind === 'error' && <ErrorNotice error={state.error} />}
      {state.kind === 'ready' && <Report report={state.report} />}
    </>
  );
}

function Report({ report }: { report: SalesReport }) {
  const { range } = report;
  const download = (section: ReportSection) =>
    downloadCsv(csvFilename(section, range.days, range.to), CSV_SECTIONS[section](report));

  return (
    <>
      <p className="muted small org-report-note">
        {range.from
          ? `${formatDay(range.from, true)} – ${formatDay(range.to, true)}`
          : `All time to ${formatDay(range.to, true)}`}{' '}
        · Singapore days · confirmed orders only
      </p>

      <section className="card org-panel">
        <PanelHead title="Summary" onDownload={() => download('summary')} empty={report.totals.length === 0} />
        {report.totals.length === 0 ? (
          <p className="muted">No sales in this period.</p>
        ) : (
          report.totals.map((t) => (
            <div key={t.currency} className="org-stats">
              <Kpi label={`Gross revenue (${t.currency})`} value={formatPrice(t.grossRevenueCents, t.currency)} />
              <Kpi label="Tickets sold" value={String(t.seatsSold)} />
              <Kpi label="Orders" value={String(t.confirmedOrders)} />
              <Kpi label="Average order" value={formatPrice(t.averageOrderCents, t.currency)} />
            </div>
          ))
        )}
      </section>

      <section className="card org-panel">
        <PanelHead title="Revenue by day" onDownload={() => download('by-day')} empty={report.byDay.length === 0} />
        {report.byDay.length === 0 ? (
          <p className="muted">No sales in this period.</p>
        ) : (
          groupByCurrency(report.byDay).map(([currency, days]) => (
            <DayChart key={currency} currency={currency} days={days} />
          ))
        )}
      </section>

      <section className="card org-panel">
        <PanelHead
          title="Revenue by concert"
          onDownload={() => download('by-concert')}
          empty={report.byConcert.length === 0}
        />
        {report.byConcert.length === 0 ? (
          <p className="muted">No sales in this period.</p>
        ) : (
          <ConcertBars rows={report.byConcert} />
        )}
      </section>

      <section className="card org-panel">
        <PanelHead
          title="Ticket types (all time)"
          onDownload={() => download('ticket-types')}
          empty={report.byTicketType.length === 0}
        />
        <p className="muted small">All sales to date, whatever the period above.</p>
        {report.byTicketType.length === 0 ? (
          <p className="muted">No tickets sold yet.</p>
        ) : (
          <div className="org-table-scroll">
            <table className="org-dash-table">
              <thead>
                <tr>
                  <th>Concert</th>
                  <th>Ticket type</th>
                  <th>Tickets sold</th>
                  <th>Orders</th>
                  <th>Ticket revenue</th>
                </tr>
              </thead>
              <tbody>
                {report.byTicketType.map((t) => (
                  <tr key={`${t.concertId}:${t.ticketTypeName}:${t.currency}`}>
                    <td>{t.concertTitle}</td>
                    <td>{t.ticketTypeName}</td>
                    <td>{t.seatsSold}</td>
                    <td>{t.confirmedOrders}</td>
                    <td>{formatPrice(t.ticketRevenueCents, t.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card org-panel">
        <PanelHead
          title="Seat status (now)"
          onDownload={() => download('seat-status')}
          empty={report.seatStatus.length === 0}
        />
        {report.seatStatus.length === 0 ? (
          <p className="muted">No concerts yet.</p>
        ) : (
          <div className="org-table-scroll">
            <table className="org-dash-table">
              <thead>
                <tr>
                  <th>Concert</th>
                  <th>Status</th>
                  <th>Available</th>
                  <th>Held</th>
                  <th>Sold</th>
                  <th>Total</th>
                  <th>% sold</th>
                </tr>
              </thead>
              <tbody>
                {report.seatStatus.map((s) => (
                  <tr key={s.concertId}>
                    <td>
                      <Link to={`/organiser/concerts/${s.concertId}`}>{s.title}</Link>
                      <br />
                      <span className="muted small">{formatDateTime(s.startsAt)}</span>
                    </td>
                    <td>{STATUS_LABELS[s.status]}</td>
                    <td>{s.available}</td>
                    <td>{s.held}</td>
                    <td>{s.sold}</td>
                    <td>{s.total}</td>
                    <td>{s.total === 0 ? '–' : `${Math.round((s.sold / s.total) * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card org-panel">
        <PanelHead
          title="Recent orders"
          onDownload={() => download('recent-orders')}
          empty={report.recentOrders.length === 0}
        />
        <p className="muted small">Newest first, up to 50 in this period.</p>
        {report.recentOrders.length === 0 ? (
          <p className="muted">No orders in this period.</p>
        ) : (
          <div className="org-table-scroll">
            <table className="org-dash-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Concert</th>
                  <th>Seats</th>
                  <th>Total</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {report.recentOrders.map((o) => (
                  <tr key={o.orderId}>
                    <td>
                      <code>{o.orderId.slice(0, 8).toUpperCase()}</code>
                    </td>
                    <td>{o.concertTitle}</td>
                    <td>{o.seats}</td>
                    <td>{formatPrice(o.grossRevenueCents, o.currency)}</td>
                    <td>{formatDateTime(o.confirmedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function PanelHead({ title, onDownload, empty }: { title: string; onDownload: () => void; empty: boolean }) {
  return (
    <div className="org-panel-head">
      <h2>{title}</h2>
      <button type="button" className="btn ghost small" onClick={onDownload} disabled={empty}>
        Download CSV
      </button>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="org-stat">
      <small className="muted">{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue by day: plain SVG bars, one chart per currency
// ---------------------------------------------------------------------------

const CHART = { width: 720, height: 220, left: 8, right: 8, top: 26, bottom: 26 };

function DayChart({ currency, days }: { currency: string; days: SalesReport['byDay'] }) {
  const max = Math.max(...days.map((d) => d.grossRevenueCents));
  if (max === 0) return <p className="muted">No {currency} sales in this period.</p>;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const slot = plotWidth / days.length;
  const barWidth = Math.max(1, slot * 0.72);
  const baseline = CHART.top + plotHeight;
  // First, last and every 7th day; skip a weekly label that would crowd the last one.
  const labelled = (i: number) => i === 0 || i === days.length - 1 || (i % 7 === 0 && days.length - 1 - i >= 4);

  return (
    <figure className="org-chart">
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={`Gross revenue per day in ${currency}`}
      >
        <text x={CHART.left} y={CHART.top - 10} className="org-chart-axis">
          {formatPrice(max, currency)}
        </text>
        <line x1={CHART.left} x2={CHART.width - CHART.right} y1={CHART.top} y2={CHART.top} className="org-chart-grid" />
        <line x1={CHART.left} x2={CHART.width - CHART.right} y1={baseline} y2={baseline} className="org-chart-base" />
        {days.map((d, i) => {
          const x = CHART.left + i * slot;
          const h = (d.grossRevenueCents / max) * plotHeight;
          return (
            <g key={d.date}>
              <title>
                {`${formatDay(d.date)}: ${formatPrice(d.grossRevenueCents, currency)} · ${d.seatsSold} tickets · ${d.confirmedOrders} orders`}
              </title>
              {/* Full-height hit area, so the tooltip also works on short or zero bars. */}
              <rect x={x} y={CHART.top} width={slot} height={plotHeight} className="org-chart-hit" />
              <rect
                x={x + (slot - barWidth) / 2}
                y={baseline - h}
                width={barWidth}
                height={h}
                className="org-chart-bar"
              />
              {labelled(i) && (
                <text
                  x={x + slot / 2}
                  y={CHART.height - 6}
                  textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
                  className="org-chart-axis"
                >
                  {formatDay(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">
        Gross revenue per day ({currency}), including booking fees. Hover a bar for details.
      </figcaption>
    </figure>
  );
}

function ConcertBars({ rows }: { rows: SalesReport['byConcert'] }) {
  // Bars compare concerts within a currency only.
  const maxByCurrency = new Map<string, number>();
  for (const r of rows)
    maxByCurrency.set(r.currency, Math.max(maxByCurrency.get(r.currency) ?? 0, r.grossRevenueCents));
  return (
    <ul className="org-bars">
      {rows.map((r) => {
        const max = maxByCurrency.get(r.currency) || 1;
        return (
          <li key={`${r.concertId}:${r.currency}`}>
            <div className="org-bars-label">
              <Link to={`/organiser/concerts/${r.concertId}`}>{r.title}</Link>
              {r.status === 'cancelled' && <span className="org-status cancelled">Cancelled</span>}
              <span className="muted small">
                {formatPrice(r.grossRevenueCents, r.currency)} · {r.seatsSold} tickets · {r.confirmedOrders} orders
              </span>
            </div>
            <div className="org-bars-track">
              <div className="org-bars-fill" style={{ width: `${(r.grossRevenueCents / max) * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByCurrency(days: SalesReport['byDay']) {
  const groups = new Map<string, SalesReport['byDay']>();
  for (const d of days) {
    const group = groups.get(d.currency);
    if (group) group.push(d);
    else groups.set(d.currency, [d]);
  }
  return [...groups];
}

/** Singapore calendar day 'YYYY-MM-DD' -> '6 Nov'. Formatted as UTC so the browser's time zone can't shift it. */
function formatDay(day: string, withYear = false) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-SG', {
    day: 'numeric',
    month: 'short',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

function downloadCsv(filename: string, csv: string) {
  // The BOM makes Excel read the file as UTF-8 (concert titles may not be ASCII).
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
