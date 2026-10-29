import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorNotice } from './ErrorNotice';
import { formatDateTime, STATUS_LABELS, toLocalInput, type OrganiserConcert } from './types';
import './organiser.css';

type State = { kind: 'loading' } | { kind: 'ready'; concerts: OrganiserConcert[] } | { kind: 'error'; error: unknown };

export function OrganiserHomePage() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ concerts: OrganiserConcert[] }>('/api/organiser/concerts')
      .then((r) => !cancelled && setState({ kind: 'ready', concerts: r.concerts }))
      .catch((error) => !cancelled && setState({ kind: 'error', error }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="section-head org-head">
        <div>
          <p className="eyebrow">Organiser</p>
          <h1>My concerts</h1>
        </div>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)}>
            + New concert
          </button>
        )}
      </div>

      {creating && <CreateConcertForm onCancel={() => setCreating(false)} />}

      {state.kind === 'loading' && <p className="muted">Loading…</p>}
      {state.kind === 'error' && <ErrorNotice error={state.error} />}
      {state.kind === 'ready' &&
        (state.concerts.length === 0 ? (
          <p className="org-empty glass">No concerts yet. Create your first one above.</p>
        ) : (
          <ul className="org-list">
            {state.concerts.map((c) => (
              <li key={c.id}>
                <Link to={`/organiser/concerts/${c.id}`} className="org-list-item glass">
                  <div className="org-list-info">
                    <strong>{c.title}</strong>
                    <small className="muted">
                      {c.artist} · {c.venueName} · {formatDateTime(c.startsAt)}
                    </small>
                  </div>
                  <span className={`org-status ${c.status}`}>{STATUS_LABELS[c.status]}</span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function CreateConcertForm({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => {
    // Sensible defaults: sale opens in a week, runs three weeks, show the day after it closes.
    const at = (days: number, hour: number) => {
      const d = new Date(Date.now() + days * DAY_MS);
      d.setHours(hour, 0, 0, 0);
      return toLocalInput(d.toISOString());
    };
    return {
      title: '',
      artist: '',
      description: '',
      venueName: '',
      venueAddress: '',
      imageUrl: '',
      saleStartsAt: at(7, 10),
      saleEndsAt: at(28, 23),
      startsAt: at(29, 20),
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const optional = (v: string) => (v.trim() ? v.trim() : undefined);
    try {
      const created = await api<OrganiserConcert>('/api/organiser/concerts', {
        method: 'POST',
        body: {
          title: form.title.trim(),
          artist: form.artist.trim(),
          description: optional(form.description),
          venueName: form.venueName.trim(),
          venueAddress: optional(form.venueAddress),
          imageUrl: optional(form.imageUrl),
          startsAt: new Date(form.startsAt).toISOString(),
          saleStartsAt: new Date(form.saleStartsAt).toISOString(),
          saleEndsAt: new Date(form.saleEndsAt).toISOString(),
        },
      });
      navigate(`/organiser/concerts/${created.id}`);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <form className="card org-form" onSubmit={onSubmit}>
      <h2>New concert</h2>
      <p className="muted small">Saved as a draft. Add ticket types and a seat layout next, then publish.</p>
      <div className="org-grid">
        <label className="field">
          <span>Title</span>
          <input required maxLength={200} value={form.title} onChange={set('title')} />
        </label>
        <label className="field">
          <span>Artist</span>
          <input required maxLength={200} value={form.artist} onChange={set('artist')} />
        </label>
        <label className="field">
          <span>Venue</span>
          <input required maxLength={200} value={form.venueName} onChange={set('venueName')} />
        </label>
        <label className="field">
          <span>Venue address (optional)</span>
          <input maxLength={500} value={form.venueAddress} onChange={set('venueAddress')} />
        </label>
        <label className="field">
          <span>Sale opens</span>
          <input type="datetime-local" required value={form.saleStartsAt} onChange={set('saleStartsAt')} />
        </label>
        <label className="field">
          <span>Sale closes</span>
          <input type="datetime-local" required value={form.saleEndsAt} onChange={set('saleEndsAt')} />
        </label>
        <label className="field">
          <span>Show starts</span>
          <input type="datetime-local" required value={form.startsAt} onChange={set('startsAt')} />
        </label>
        <label className="field">
          <span>Image URL (optional)</span>
          <input type="url" maxLength={2000} placeholder="https://…" value={form.imageUrl} onChange={set('imageUrl')} />
        </label>
        <label className="field wide">
          <span>Description (optional)</span>
          <textarea rows={3} maxLength={5000} value={form.description} onChange={set('description')} />
        </label>
      </div>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? 'Creating…' : 'Create draft'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
