import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { formatPrice, formatSeat, formatTicketDate, isCancelled, shortOrderId, type Order } from './types';
import './tickets.css';

type State =
  { kind: 'loading' } | { kind: 'ready'; order: Order } | { kind: 'not-found' } | { kind: 'error'; message: string };

export function TicketDetailPage() {
  const { ticketId = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api<Order>(`/api/me/tickets/${encodeURIComponent(ticketId)}`)
      .then((order) => !cancelled && setState({ kind: 'ready', order }))
      .catch((e) => {
        if (cancelled) return;
        // 404 covers "no such ticket" and "not yours"; 400 is an id that isn't a ticket id at all.
        const missing = e instanceof ApiError && (e.status === 404 || e.status === 400);
        setState(missing ? { kind: 'not-found' } : { kind: 'error', message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  async function download() {
    setMessage(undefined);
    setDownloading(true);
    try {
      const { url } = await api<{ url: string; expiresInSeconds: number }>(
        `/api/me/tickets/${encodeURIComponent(ticketId)}/download`,
      );
      // Plain navigation to the 5-minute S3 link: the PDF comes as an attachment, so the page stays put.
      window.location.assign(url);
    } catch (e) {
      // 503: no PDF bucket configured yet. 409: the PDF for this order hasn't been written yet.
      setMessage(
        e instanceof ApiError && e.status === 503
          ? "E-ticket PDFs aren't ready yet. You'll also get yours by email."
          : e instanceof ApiError && e.status === 409
            ? 'Your e-ticket is still being prepared. Try again in a minute.'
            : `Download failed: ${(e as Error).message}`,
      );
    } finally {
      setDownloading(false);
    }
  }

  if (state.kind === 'loading') return <p className="muted center">Loading ticket…</p>;
  if (state.kind !== 'ready') {
    return (
      <section className="card">
        <h1>{state.kind === 'not-found' ? 'Ticket not found' : "Couldn't load this ticket"}</h1>
        {state.kind === 'error' && <p className="muted">{state.message}</p>}
        <div className="row">
          <Link to="/myaccount" className="btn">
            Back to my tickets
          </Link>
        </div>
      </section>
    );
  }

  const { order } = state;
  const { date, time } = formatTicketDate(order.concert.startsAt);

  return (
    <section className="ticket-view">
      <header className="ticket-view-head">
        <Link to="/myaccount" className="circle-btn" aria-label="Back to my tickets">
          ‹
        </Link>
        <h1>Ticket</h1>
        <span className="circle-spacer" aria-hidden="true" />
      </header>

      {isCancelled(order) && (
        <p className="tickets-notice glass" role="status">
          This concert has been cancelled.
        </p>
      )}

      <div className="ticket-frame glass">
        <div className="ticket-image">{order.concert.imageUrl && <img src={order.concert.imageUrl} alt="" />}</div>

        <article className="eticket">
          <div className="eticket-main">
            <div className="eticket-title">
              <h2>{order.concert.title}</h2>
              <p>{order.concert.artist}</p>
            </div>
            <dl className="eticket-details">
              <div>
                <dt>Date</dt>
                <dd>{date}</dd>
              </div>
              <div className="right">
                <dt>Time</dt>
                <dd>{time}</dd>
              </div>
              <div>
                <dt>Venue</dt>
                <dd>{order.concert.venueName}</dd>
              </div>
              <div className="right">
                <dt>Order</dt>
                <dd>{shortOrderId(order.orderId)}</dd>
              </div>
              <div className="wide">
                <dt>{order.seats.length === 1 ? 'Seat' : 'Seats'}</dt>
                <dd>
                  <ul className="eticket-seats">
                    {order.seats.map((s) => (
                      <li key={`${s.section}-${s.row}-${s.seatNumber}`}>
                        <span>{formatSeat(s)}</span>
                        <span className="eticket-seat-type">
                          {s.ticketType} · {formatPrice(s.priceCents, order.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Booking fee</dt>
                <dd>{formatPrice(order.bookingFeeCents, order.currency)}</dd>
              </div>
              <div className="right">
                <dt>Total paid</dt>
                <dd>{formatPrice(order.totalCents, order.currency)}</dd>
              </div>
            </dl>
          </div>
          <div className="eticket-stub">
            <div className="eticket-barcode" aria-hidden="true" />
          </div>
        </article>
      </div>

      <div className="ticket-actions single">
        <button type="button" onClick={download} disabled={downloading}>
          {downloading ? 'Preparing…' : '⤓ Download e-ticket (PDF)'}
        </button>
      </div>
      {message && (
        <p className="muted small center" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
