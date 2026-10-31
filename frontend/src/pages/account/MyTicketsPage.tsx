import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ProfileCard } from './ProfileCard';
import { formatSeatCount, formatTicketDate, isCancelled, type Order } from './types';
import './tickets.css';

type State = { kind: 'loading' } | { kind: 'ready'; orders: Order[] } | { kind: 'error'; message: string };

export function MyTicketsPage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api<{ orders: Order[] }>('/api/me/orders')
      .then((r) => !cancelled && setState({ kind: 'ready', orders: r.orders }))
      .catch((e) => !cancelled && setState({ kind: 'error', message: (e as Error).message }));
    return () => {
      cancelled = true;
    };
  }, []);

  // The API sends newest purchase first. Upcoming shows soonest first; past keeps the most recent concert first.
  const now = Date.now();
  const orders = state.kind === 'ready' ? state.orders : [];
  const upcoming = orders
    .filter((o) => Date.parse(o.concert.startsAt) >= now)
    .sort((a, b) => Date.parse(a.concert.startsAt) - Date.parse(b.concert.startsAt));
  const past = orders
    .filter((o) => Date.parse(o.concert.startsAt) < now)
    .sort((a, b) => Date.parse(b.concert.startsAt) - Date.parse(a.concert.startsAt));

  return (
    <section className="tickets-page">
      <h1 className="tickets-heading">My Tickets</h1>

      {state.kind === 'loading' && <p className="muted">Loading your tickets…</p>}
      {state.kind === 'error' && <p className="tickets-notice glass">Couldn't load your tickets: {state.message}</p>}
      {state.kind === 'ready' && orders.length === 0 && (
        <p className="tickets-notice glass">
          No tickets yet. <Link to="/">Find a concert</Link> to get started.
        </p>
      )}

      {upcoming.length > 0 && <TicketList title="Upcoming" orders={upcoming} />}
      {past.length > 0 && <TicketList title="Past" orders={past} />}

      <ProfileCard />
    </section>
  );
}

function TicketList({ title, orders }: { title: string; orders: Order[] }) {
  return (
    <>
      <h2 className="tickets-subheading">{title}</h2>
      <div className="ticket-list">
        {orders.map((o) => {
          const { date, time } = formatTicketDate(o.concert.startsAt);
          return (
            <Link key={o.orderId} to={`/myaccount/tickets/${o.orderId}`} className="ticket-row glass">
              <div className="ticket-thumb">{o.concert.imageUrl && <img src={o.concert.imageUrl} alt="" />}</div>
              <div className="ticket-row-info">
                <strong>{o.concert.title}</strong>
                <small>
                  {date} · {time}
                </small>
                <small>
                  {o.concert.venueName} · {formatSeatCount(o.seats)}
                </small>
                {isCancelled(o) && <span className="badge ticket-badge">Concert cancelled</span>}
              </div>
              <span className="ticket-row-cta">View ticket ›</span>
            </Link>
          );
        })}
      </div>
    </>
  );
}
