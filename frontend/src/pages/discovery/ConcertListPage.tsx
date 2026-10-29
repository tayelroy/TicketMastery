import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { formatPrice, type ConcertSummary } from './types';
import './concerts.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; concerts: ConcertSummary[] }
  | { kind: 'error'; message: string };

/** Wait this long after the last keystroke before searching, so typing does not fire a request per key. */
const SEARCH_DEBOUNCE_MS = 300;

export function ConcertListPage() {
  const { session } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const search = query.trim();

  // Search runs on the API (title, artist and venue), so it covers every concert, not just the loaded page.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(
      () => {
        const params = search ? `?${new URLSearchParams({ q: search })}` : '';
        api<{ concerts: ConcertSummary[] }>(`/api/concerts${params}`)
          .then((r) => !cancelled && setState({ kind: 'ready', concerts: r.concerts }))
          .catch((e) => !cancelled && setState({ kind: 'error', message: (e as Error).message }));
      },
      search ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  return (
    <>
      <section className="greeting">
        <span className="avatar large">{session ? (session.email ?? session.userId).charAt(0) : '♪'}</span>
        <div>
          <h1>Hello{session ? ` ${session.email ?? session.userId}` : ''}</h1>
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

      {state.kind === 'error' && <p className="notice glass">Couldn't load concerts: {state.message}</p>}

      {state.kind === 'loading' ? (
        <div className="event-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="event-card skeleton" />
          ))}
        </div>
      ) : state.kind === 'ready' && state.concerts.length ? (
        <div className="event-grid">
          {state.concerts.map((c) => (
            <EventCard key={c.id} concert={c} />
          ))}
        </div>
      ) : state.kind === 'ready' ? (
        <p className="notice glass">
          {search ? `No concerts match “${search}”.` : 'No upcoming concerts yet. Check back soon.'}
        </p>
      ) : null}
    </>
  );
}

function EventCard({ concert }: { concert: ConcertSummary }) {
  const date = new Date(concert.startsAt);
  const day = date.toLocaleDateString('en-SG', { day: 'numeric' });
  const month = date.toLocaleDateString('en-SG', { month: 'short' });
  const time = date.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' });

  return (
    <Link to={`/concerts/${concert.id}`} className="event-card">
      {concert.imageUrl ? (
        <img src={concert.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className="event-image-empty" aria-hidden="true" />
      )}

      <span className="date-bubble">
        <strong>{day}</strong>
        <small>{month}</small>
      </span>
      {concert.status === 'sold_out' && <span className="badge status-badge">Sold out</span>}

      <div className="event-bar">
        <span className="avatar">{concert.artist.charAt(0)}</span>
        <div className="event-info">
          <strong>{concert.title}</strong>
          <small>
            {concert.venueName} · {time}
          </small>
        </div>
        <span className="price-pill">
          {concert.minPriceCents !== null && concert.currency
            ? `From ${formatPrice(concert.minPriceCents, concert.currency)}`
            : 'Tickets'}
        </span>
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
