import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import './concerts.css';

/** One concert as GET /api/concerts returns it (same camelCase fields as the organiser API). */
export interface ConcertSummary {
  id: string;
  title: string;
  artist: string;
  venueName: string;
  startsAt: string;
  imageUrl: string | null;
}

/** Shown only while GET /api/concerts is still a 501 stub, so the card design can be seen. Not real data. */
const SAMPLE: ConcertSummary = {
  id: 'sample',
  title: 'Sample Concert',
  artist: 'Sample Artist',
  venueName: 'Singapore Indoor Stadium',
  startsAt: '2026-12-19T14:00:00Z',
  imageUrl: null,
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; concerts: ConcertSummary[] }
  | { kind: 'not-built' }
  | { kind: 'error'; message: string };

export function ConcertListPage() {
  const { session } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<{ concerts: ConcertSummary[] }>('/api/concerts')
      .then((r) => !cancelled && setState({ kind: 'ready', concerts: r.concerts }))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 501) setState({ kind: 'not-built' });
        else setState({ kind: 'error', message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const concerts = state.kind === 'ready' ? state.concerts : state.kind === 'not-built' ? [SAMPLE] : [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return concerts;
    return concerts.filter((c) => [c.title, c.artist, c.venueName].some((s) => s.toLowerCase().includes(q)));
  }, [concerts, query]);

  return (
    <>
      <section className="greeting">
        <span className="avatar large">{session ? session.userId.charAt(0) : '♪'}</span>
        <div>
          <h1>Hello{session ? ` ${session.userId}` : ''}</h1>
          <p className="muted">Find your next live night.</p>
        </div>
      </section>

      <label className="search">
        <SearchIcon />
        <input
          type="search"
          placeholder="Search all events…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search concerts by title, artist or venue"
        />
      </label>

      <div className="section-head">
        <h2>Upcoming Events</h2>
        {state.kind === 'ready' && <span className="muted small">{state.concerts.length} shows</span>}
      </div>

      {state.kind === 'not-built' && (
        <p className="notice glass">
          Preview: <code>GET /api/concerts</code> is not built yet, so this is a sample card showing the design.
        </p>
      )}
      {state.kind === 'error' && <p className="notice glass">Couldn't load concerts: {state.message}</p>}

      {state.kind === 'loading' ? (
        <div className="event-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="event-card skeleton" />
          ))}
        </div>
      ) : visible.length ? (
        <div className="event-grid">
          {visible.map((c) => (
            <EventCard key={c.id} concert={c} />
          ))}
        </div>
      ) : (
        <p className="notice glass">
          {query ? `No concerts match “${query}”.` : 'No upcoming concerts yet. Check back soon.'}
        </p>
      )}
    </>
  );
}

function EventCard({ concert }: { concert: ConcertSummary }) {
  const date = new Date(concert.startsAt);
  const day = date.toLocaleDateString('en-SG', { day: 'numeric' });
  const month = date.toLocaleDateString('en-SG', { month: 'short' });
  const time = date.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });
  const isSample = concert.id === SAMPLE.id;

  return (
    <Link
      to={isSample ? '#' : `/concerts/${concert.id}`}
      className="event-card"
      onClick={isSample ? (e) => e.preventDefault() : undefined}
      aria-disabled={isSample || undefined}
    >
      {concert.imageUrl ? (
        <img src={concert.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className="event-image-empty" aria-hidden="true" />
      )}

      <span className="date-bubble">
        <strong>{day}</strong>
        <small>{month}</small>
      </span>

      <div className="event-bar">
        <span className="avatar">{concert.artist.charAt(0)}</span>
        <div className="event-info">
          <strong>{concert.title}</strong>
          <small>
            {concert.venueName} · {time}
          </small>
        </div>
        <span className="price-pill">Tickets</span>
      </div>
    </Link>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}
