import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { ErrorNotice } from './ErrorNotice';
import {
  formatDateTime,
  formatPrice,
  STATUS_LABELS,
  type Dashboard,
  type OrganiserConcertDetail,
  type OrganiserTicketType,
} from './types';
import './organiser.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; concert: OrganiserConcertDetail }
  | { kind: 'error'; error: unknown };

/** The API marks the dashboard no-store; this matches the "live" feel without hammering it. */
const DASHBOARD_REFRESH_MS = 5_000;

export function OrganiserConcertPage() {
  const { concertId = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const path = `/api/organiser/concerts/${encodeURIComponent(concertId)}`;

  const reload = useCallback(
    () =>
      api<OrganiserConcertDetail>(path)
        .then((concert) => setState({ kind: 'ready', concert }))
        .catch((error) => setState({ kind: 'error', error })),
    [path],
  );

  useEffect(() => {
    setState({ kind: 'loading' });
    void reload();
  }, [reload]);

  if (state.kind === 'loading') return <p className="muted">Loading…</p>;
  if (state.kind === 'error') {
    const notFound = state.error instanceof ApiError && [400, 403, 404].includes(state.error.status);
    return (
      <section className="card">
        <h1>{notFound ? 'Concert not found' : "Couldn't load this concert"}</h1>
        {notFound ? <p className="muted">It doesn't exist or belongs to another organiser.</p> : <ErrorNotice error={state.error} />}
        <div className="row">
          <Link to="/organiser" className="btn">
            Back to my concerts
          </Link>
        </div>
      </section>
    );
  }

  const { concert } = state;
  const closed = concert.status === 'cancelled' || concert.status === 'completed';

  return (
    <>
      <Link to="/organiser" className="org-back">
        ‹ My concerts
      </Link>

      <section className="card org-summary">
        <div className="org-summary-head">
          <div>
            <p className="eyebrow">{concert.artist}</p>
            <h1>{concert.title}</h1>
          </div>
          <span className={`org-status ${concert.status}`}>{STATUS_LABELS[concert.status]}</span>
        </div>
        <dl className="org-facts">
          <div>
            <dt>Show</dt>
            <dd>{formatDateTime(concert.startsAt)}</dd>
          </div>
          <div>
            <dt>Venue</dt>
            <dd>{concert.venueName}</dd>
          </div>
          <div>
            <dt>Sale window</dt>
            <dd>
              {formatDateTime(concert.saleStartsAt)} – {formatDateTime(concert.saleEndsAt)}
            </dd>
          </div>
        </dl>
        {concert.status === 'cancelled' && (
          <p className="org-banner bad">Cancelled{concert.cancellationReason ? `: ${concert.cancellationReason}` : ''}</p>
        )}
        {concert.layoutLocked && !closed && (
          <p className="org-banner">Ticket types and the seat layout are locked because the sale has started.</p>
        )}
        {concert.status !== 'draft' && (
          <div className="row">
            <Link to={`/concerts/${concert.id}`} className="btn ghost small">
              View public page
            </Link>
          </div>
        )}
      </section>

      {concert.status !== 'draft' && <DashboardPanel path={path} live={!closed} />}

      {concert.layoutLocked ? (
        <TicketTypesReadOnly ticketTypes={concert.ticketTypes} />
      ) : (
        <TicketTypesEditor key={`types:${ticketTypesKey(concert.ticketTypes)}`} concert={concert} onSaved={reload} path={path} />
      )}
      {!concert.layoutLocked && concert.ticketTypes.length > 0 && (
        <LayoutEditor key={`layout:${ticketTypesKey(concert.ticketTypes)}`} concert={concert} onSaved={reload} path={path} />
      )}
      {concert.layoutLocked && <LayoutSummary concert={concert} />}

      {/* Shown last, once the draft has everything it needs, so it reads as the final step. */}
      {concert.status === 'draft' && readyToPublish(concert) && (
        <PublishPanel concert={concert} onChanged={reload} path={path} />
      )}
      {!closed && <CancelPanel onChanged={reload} path={path} />}
    </>
  );
}

/**
 * Remounts the ticket type and layout forms (resetting their inputs) whenever the saved ticket types change.
 * Each form prefixes it, since sibling keys must differ.
 */
const ticketTypesKey = (types: OrganiserTicketType[]) =>
  types.map((t) => `${t.id}:${t.priceCents}:${t.quantity}:${t.maxPerOrder}`).join('|');

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Mirrors the API's publish check: ticket types exist and every one has exactly `quantity` seats. */
const readyToPublish = (c: OrganiserConcertDetail) =>
  c.ticketTypes.length > 0 && c.ticketTypes.every((t) => t.seatCount === t.quantity);

function PublishPanel({ concert, onChanged, path }: { concert: OrganiserConcertDetail; onChanged: () => void; path: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const hasTypes = concert.ticketTypes.length > 0;
  const layoutMatches = readyToPublish(concert);

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await api(`${path}/publish`, { method: 'POST' });
      onChanged();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <section className="card org-panel">
      <h2>Get ready to publish</h2>
      <ol className="org-checklist">
        <li className={hasTypes ? 'done' : ''}>Add ticket types (name, price, quantity)</li>
        <li className={layoutMatches ? 'done' : ''}>Save a seat layout with exactly one seat per ticket</li>
        <li>Publish: fans can see the concert, and the sale opens on {formatDateTime(concert.saleStartsAt)}</li>
      </ol>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" onClick={publish} disabled={busy || !layoutMatches}>
          {busy ? 'Publishing…' : 'Publish concert'}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Ticket types
// ---------------------------------------------------------------------------

interface TicketTypeDraft {
  name: string;
  description: string;
  /** Dollars as typed, e.g. "128" or "88.50". */
  price: string;
  quantity: string;
  maxPerOrder: string;
  currency: string;
}

const emptyTicketType = (): TicketTypeDraft => ({
  name: '',
  description: '',
  price: '',
  quantity: '',
  maxPerOrder: '4',
  currency: 'SGD',
});

function TicketTypesEditor({ concert, onSaved, path }: { concert: OrganiserConcertDetail; onSaved: () => void; path: string }) {
  const [rows, setRows] = useState<TicketTypeDraft[]>(() =>
    concert.ticketTypes.length
      ? concert.ticketTypes.map((t) => ({
          name: t.name,
          description: t.description ?? '',
          price: String(t.priceCents / 100),
          quantity: String(t.quantity),
          maxPerOrder: String(t.maxPerOrder),
          currency: t.currency,
        }))
      : [emptyTicketType()],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const update = (i: number, key: keyof TicketTypeDraft, value: string) => {
    setSaved(false);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`${path}/ticket-types`, {
        method: 'PUT',
        body: {
          ticketTypes: rows.map((r) => ({
            name: r.name.trim(),
            ...(r.description.trim() ? { description: r.description.trim() } : {}),
            priceCents: Math.round(Number(r.price) * 100),
            currency: r.currency,
            quantity: Number(r.quantity),
            maxPerOrder: Number(r.maxPerOrder),
          })),
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card org-panel" onSubmit={onSubmit}>
      <h2>Ticket types</h2>
      <p className="muted small">
        Each ticket type needs exactly as many seats in the layout as its quantity. Renaming a type that seats use
        means saving a new layout first.
      </p>
      <div className="org-table" role="table">
        <div className="org-tt-row head" role="row">
          <span>Name</span>
          <span>Description</span>
          <span>Price ({rows[0]?.currency ?? 'SGD'})</span>
          <span>Quantity</span>
          <span>Max / order</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div className="org-tt-row" role="row" key={i}>
            <input aria-label="Name" required maxLength={50} placeholder="CAT1" value={r.name} onChange={(e) => update(i, 'name', e.target.value)} />
            <input aria-label="Description" maxLength={1000} placeholder="Optional" value={r.description} onChange={(e) => update(i, 'description', e.target.value)} />
            <input aria-label="Price" required type="number" min="0" step="0.01" value={r.price} onChange={(e) => update(i, 'price', e.target.value)} />
            <input aria-label="Quantity" required type="number" min="1" step="1" value={r.quantity} onChange={(e) => update(i, 'quantity', e.target.value)} />
            <input aria-label="Max per order" required type="number" min="1" max="20" step="1" value={r.maxPerOrder} onChange={(e) => update(i, 'maxPerOrder', e.target.value)} />
            <button
              type="button"
              className="link"
              aria-label={`Remove ${r.name || 'ticket type'}`}
              disabled={rows.length === 1}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" className="btn ghost small" onClick={() => setRows((rs) => [...rs, emptyTicketType()])}>
          + Add ticket type
        </button>
        <button type="submit" className="small" disabled={saving}>
          {saving ? 'Saving…' : 'Save ticket types'}
        </button>
        {saved && <span className="org-saved">Saved</span>}
      </div>
    </form>
  );
}

function TicketTypesReadOnly({ ticketTypes }: { ticketTypes: OrganiserTicketType[] }) {
  return (
    <section className="card org-panel">
      <h2>Ticket types</h2>
      <ul className="org-readonly">
        {ticketTypes.map((t) => (
          <li key={t.id}>
            <strong>{t.name}</strong>
            <span className="muted">
              {formatPrice(t.priceCents, t.currency)} · {t.quantity} seats · max {t.maxPerOrder} per order
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seat layout
// ---------------------------------------------------------------------------

interface RowDraft {
  label: string;
  ticketTypeName: string;
  from: string;
  to: string;
}

interface SectionDraft {
  name: string;
  rows: RowDraft[];
}

/** Matches the API limit; the generator also keeps rows a readable width. */
const SEATS_PER_GENERATED_ROW = 20;

/** 0 -> A, 25 -> Z, 26 -> AA ... */
function rowLabel(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : rowLabel(Math.floor(i / 26) - 1) + rowLabel(i % 26);
}

/** One section with consecutive rows per ticket type (in ticket type order), sized to each quantity. */
function generateLayout(ticketTypes: OrganiserTicketType[]): SectionDraft[] {
  const rows: RowDraft[] = [];
  for (const t of ticketTypes) {
    for (let left = t.quantity; left > 0; left -= SEATS_PER_GENERATED_ROW) {
      const n = Math.min(left, SEATS_PER_GENERATED_ROW);
      rows.push({ label: rowLabel(rows.length), ticketTypeName: t.name, from: '1', to: String(n) });
    }
  }
  return [{ name: 'Floor', rows }];
}

function rowSeatCount(r: RowDraft) {
  const from = Number(r.from);
  const to = Number(r.to);
  return Number.isInteger(from) && Number.isInteger(to) && to >= from && from >= 1 ? to - from + 1 : 0;
}

function LayoutEditor({ concert, onSaved, path }: { concert: OrganiserConcertDetail; onSaved: () => void; path: string }) {
  const [sections, setSections] = useState<SectionDraft[]>(() => generateLayout(concert.ticketTypes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const seatsByType = new Map<string, number>();
  for (const s of sections) {
    for (const r of s.rows) seatsByType.set(r.ticketTypeName, (seatsByType.get(r.ticketTypeName) ?? 0) + rowSeatCount(r));
  }

  const edit = (fn: (draft: SectionDraft[]) => SectionDraft[]) => {
    setSaved(false);
    setSections(fn);
  };
  const updateSection = (si: number, name: string) =>
    edit((ss) => ss.map((s, i) => (i === si ? { ...s, name } : s)));
  const updateRow = (si: number, ri: number, key: keyof RowDraft, value: string) =>
    edit((ss) =>
      ss.map((s, i) => (i === si ? { ...s, rows: s.rows.map((r, j) => (j === ri ? { ...r, [key]: value } : r)) } : s)),
    );
  const addRow = (si: number) =>
    edit((ss) =>
      ss.map((s, i) =>
        i === si
          ? {
              ...s,
              rows: [...s.rows, { label: rowLabel(s.rows.length), ticketTypeName: concert.ticketTypes[0]!.name, from: '1', to: '10' }],
            }
          : s,
      ),
    );
  const removeRow = (si: number, ri: number) =>
    edit((ss) => ss.map((s, i) => (i === si ? { ...s, rows: s.rows.filter((_, j) => j !== ri) } : s)));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`${path}/layout`, {
        method: 'PUT',
        body: {
          sections: sections.map((s) => ({
            name: s.name.trim(),
            rows: s.rows.map((r) => ({
              label: r.label.trim(),
              ticketTypeName: r.ticketTypeName,
              seats: { from: Number(r.from), to: Number(r.to) },
            })),
          })),
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const { totals } = concert.layout;

  return (
    <form className="card org-panel" onSubmit={onSubmit}>
      <h2>Seat layout</h2>
      <p className="muted small">
        {totals.seats > 0
          ? `Saved layout: ${totals.sections} section(s), ${totals.rows} rows, ${totals.seats} seats. Saving below replaces it.`
          : 'No layout saved yet. A starting layout is filled in from your ticket types; adjust it and save.'}
      </p>

      <ul className="org-tally">
        {concert.ticketTypes.map((t) => {
          const n = seatsByType.get(t.name) ?? 0;
          return (
            <li key={t.id} className={n === t.quantity ? 'ok' : 'bad'}>
              {t.name}: {n} / {t.quantity} seats
            </li>
          );
        })}
      </ul>

      {sections.map((s, si) => (
        <fieldset key={si} className="org-section">
          <legend>
            <input aria-label="Section name" required maxLength={50} value={s.name} onChange={(e) => updateSection(si, e.target.value)} />
            {sections.length > 1 && (
              <button type="button" className="link" onClick={() => edit((ss) => ss.filter((_, i) => i !== si))}>
                Remove section
              </button>
            )}
          </legend>
          <div className="org-layout-row head">
            <span>Row</span>
            <span>Ticket type</span>
            <span>Seats from</span>
            <span>to</span>
            <span />
          </div>
          {s.rows.map((r, ri) => (
            <div key={ri} className="org-layout-row">
              <input aria-label="Row label" required maxLength={10} value={r.label} onChange={(e) => updateRow(si, ri, 'label', e.target.value)} />
              <select aria-label="Ticket type" value={r.ticketTypeName} onChange={(e) => updateRow(si, ri, 'ticketTypeName', e.target.value)}>
                {concert.ticketTypes.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input aria-label="First seat" required type="number" min="1" value={r.from} onChange={(e) => updateRow(si, ri, 'from', e.target.value)} />
              <input aria-label="Last seat" required type="number" min="1" value={r.to} onChange={(e) => updateRow(si, ri, 'to', e.target.value)} />
              <button type="button" className="link" aria-label={`Remove row ${r.label}`} disabled={s.rows.length === 1} onClick={() => removeRow(si, ri)}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn ghost small" onClick={() => addRow(si)}>
            + Add row
          </button>
        </fieldset>
      ))}

      <ErrorNotice error={error} />
      <div className="row">
        <button
          type="button"
          className="btn ghost small"
          onClick={() => edit((ss) => [...ss, { name: `Section ${ss.length + 1}`, rows: [{ label: 'A', ticketTypeName: concert.ticketTypes[0]!.name, from: '1', to: '10' }] }])}
        >
          + Add section
        </button>
        <button type="button" className="btn ghost small" onClick={() => edit(() => generateLayout(concert.ticketTypes))}>
          Reset to generated
        </button>
        <button type="submit" className="small" disabled={saving}>
          {saving ? 'Saving…' : 'Save layout'}
        </button>
        {saved && <span className="org-saved">Saved</span>}
      </div>
    </form>
  );
}

function LayoutSummary({ concert }: { concert: OrganiserConcertDetail }) {
  return (
    <section className="card org-panel">
      <h2>Seat layout</h2>
      <ul className="org-readonly">
        {concert.layout.sections.map((s) => (
          <li key={s.id}>
            <strong>{s.name}</strong>
            <span className="muted">
              {s.rowCount} rows · {s.seatCount} seats
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live sales dashboard
// ---------------------------------------------------------------------------

function DashboardPanel({ path, live }: { path: string; live: boolean }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Dashboard>(`${path}/dashboard`)
        .then((d) => {
          if (cancelled) return;
          setDashboard(d);
          setError(null);
        })
        .catch((e) => !cancelled && setError(e));
    void load();
    const timer = live ? setInterval(load, DASHBOARD_REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, live]);

  return (
    <section className="card org-panel">
      <div className="org-panel-head">
        <h2>Sales</h2>
        {dashboard && (
          <span className="muted small">
            {live ? 'Live · ' : ''}updated {new Date(dashboard.generatedAt).toLocaleTimeString('en-SG')}
          </span>
        )}
      </div>
      <ErrorNotice error={error} />
      {dashboard && (
        <>
          <div className="org-stats">
            <Stat label="Sold" value={`${dashboard.totals.sold} / ${dashboard.totals.total}`} />
            <Stat label="Held in checkout" value={String(dashboard.totals.held)} />
            <Stat label="Available" value={String(dashboard.totals.available)} />
            <Stat label="Revenue" value={formatPrice(dashboard.totals.revenueCents, dashboard.ticketTypes[0]?.currency)} />
          </div>
          <table className="org-dash-table">
            <thead>
              <tr>
                <th>Ticket type</th>
                <th>Sold</th>
                <th>Held</th>
                <th>Available</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.ticketTypes.map((t) => (
                <tr key={t.ticketTypeId}>
                  <td>
                    {t.name} <span className="muted small">{formatPrice(t.priceCents, t.currency)}</span>
                  </td>
                  <td>
                    {t.sold} / {t.total}
                  </td>
                  <td>{t.held}</td>
                  <td>{t.available}</td>
                  <td>{formatPrice(t.revenueCents, t.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="org-stat">
      <small className="muted">{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

function CancelPanel({ onChanged, path }: { onChanged: () => void; path: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`${path}/cancel`, { method: 'POST', body: { reason: reason.trim() } });
      onChanged();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="org-danger-link">
        <button type="button" className="link" onClick={() => setOpen(true)}>
          Cancel this concert…
        </button>
      </div>
    );
  }

  return (
    <form className="card org-panel org-danger" onSubmit={onSubmit}>
      <h2>Cancel concert</h2>
      <p className="muted small">This cannot be undone. Fans will see the reason on the concert page.</p>
      <label className="field">
        <span>Reason</span>
        <textarea required rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="submit" className="danger" disabled={busy || !reason.trim()}>
          {busy ? 'Cancelling…' : 'Cancel concert'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>
          Keep it
        </button>
      </div>
    </form>
  );
}
