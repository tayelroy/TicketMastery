import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { formatConcertDate, formatMoney, type Hold, type SeatMap } from './types';
import './checkout.css';

/** Same cap as the API (MAX_SEATS_PER_HOLD); the per-ticket-type limit comes from the seat map. */
const MAX_SEATS_PER_HOLD = 20;

/** Friendly text for the API's error codes; anything else shows the API's own message. */
const ERROR_TEXT: Record<string, string> = {
  seats_unavailable: 'Some of those seats were just taken. The seat map has been refreshed, please pick again.',
  active_hold_exists: 'You already have seats on hold for this concert.',
  not_on_sale: 'Tickets for this concert are not on sale right now.',
  not_admitted: 'You need to go through the waiting room first.',
  too_many_seats: 'That is more seats of one ticket type than a single order allows.',
  hold_expired: 'Your 10-minute hold ran out and the seats were released. Please pick again.',
  hold_cancelled: 'That hold was already released. Please pick again.',
  payment_failed: 'Payment was declined and your seats were released. Please pick again.',
  concert_cancelled: 'This concert has been cancelled.',
  order_confirmed: 'This order is already paid for.',
};

/** Errors after which the seat map is out of date and should be fetched again. */
const RELOAD_AFTER = new Set([
  'seats_unavailable',
  'active_hold_exists',
  'hold_expired',
  'hold_cancelled',
  'payment_failed',
  'concert_cancelled',
]);

/** Re-renders every second while `active`, for the hold countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function CheckoutPage() {
  const { concertId = '' } = useParams();
  const [map, setMap] = useState<SeatMap | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [hold, setHold] = useState<Hold | null>(null);
  const [confirmed, setConfirmed] = useState<Hold | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<SeatMap>(`/api/checkout/concerts/${encodeURIComponent(concertId)}/seats`);
      setMap(next);
      setHold(next.activeHold);
      setSelected([]);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? 'Concert not found.' : 'Could not load the seats.');
    }
  }, [concertId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Seat id -> what the summary needs to show about it. */
  const seatInfo = useMemo(() => {
    const info = new Map<string, { label: string; ticketTypeId: string }>();
    for (const section of map?.sections ?? []) {
      for (const row of section.rows) {
        for (const seat of row.seats) {
          const label = `${section.name} · Row ${row.label} · Seat ${seat.seatNumber}`;
          info.set(seat.id, { label, ticketTypeId: seat.ticketTypeId });
        }
      }
    }
    return info;
  }, [map]);

  /** Ticket type id -> type plus its colour slot (tt-0 … tt-3 in checkout.css). */
  const ticketTypes = useMemo(
    () => new Map((map?.ticketTypes ?? []).map((t, i) => [t.id, { ...t, colour: i % 4 }])),
    [map],
  );

  const now = useNow(hold !== null);
  const remainingMs = hold ? new Date(hold.expiresAt).getTime() - now : 0;
  const holdRanOut = hold !== null && remainingMs <= 0;

  /** Runs an API call with the busy flag, turning API errors into a notice (and a fresh seat map if needed). */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError) {
        setNotice(ERROR_TEXT[err.code] ?? err.message);
        if (RELOAD_AFTER.has(err.code)) await load();
      } else {
        setNotice('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleSeat(seatId: string) {
    setNotice(null);
    if (selected.includes(seatId)) {
      setSelected(selected.filter((id) => id !== seatId));
      return;
    }
    const type = ticketTypes.get(seatInfo.get(seatId)?.ticketTypeId ?? '');
    const sameType = selected.filter((id) => seatInfo.get(id)?.ticketTypeId === type?.id).length;
    if (type && sameType >= type.maxPerOrder) {
      setNotice(`You can pick up to ${type.maxPerOrder} ${type.name} seats per order.`);
      return;
    }
    if (selected.length >= MAX_SEATS_PER_HOLD) {
      setNotice(`You can pick up to ${MAX_SEATS_PER_HOLD} seats per order.`);
      return;
    }
    setSelected([...selected, seatId]);
  }

  const holdSeats = () =>
    run(async () => {
      await api<Hold>('/api/checkout/holds', { method: 'POST', body: { concertId, seatIds: selected } });
      await load();
    });

  const release = () =>
    run(async () => {
      await api<Hold>(`/api/checkout/holds/${hold!.holdId}`, { method: 'DELETE' });
      await load();
    });

  const pay = () =>
    run(async () => {
      const order = await api<Hold>(`/api/checkout/holds/${hold!.holdId}/confirm`, {
        method: 'POST',
        body: { simulatePaymentFailure: simulateFailure },
      });
      setConfirmed(order);
      setHold(null);
    });

  if (loadError) {
    return (
      <section className="card narrow">
        <h1>Checkout</h1>
        <p className="muted">{loadError}</p>
        <Link to="/concerts" className="btn">
          Back to concerts
        </Link>
      </section>
    );
  }
  if (!map) {
    return <p className="muted">Loading seats…</p>;
  }

  const { concert } = map;
  const currency = map.ticketTypes[0]?.currency ?? 'SGD';

  if (confirmed) {
    return (
      <section className="checkout-page">
        <div className="card checkout-done">
          <p className="eyebrow">Order confirmed</p>
          <h1>You're going to {concert.title}!</h1>
          <p className="muted">
            {formatConcertDate(concert.startsAt)} · {concert.venueName}
          </p>
          <OrderLines order={confirmed} />
          <p className="muted small">
            Your e-tickets are on their way by email. You'll also find them under My Tickets.
          </p>
          <div className="row">
            <Link to="/myaccount/tickets" className="btn">
              My Tickets
            </Link>
            <Link to="/concerts" className="btn ghost">
              More concerts
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const priceOf = (seatId: string) => ticketTypes.get(seatInfo.get(seatId)?.ticketTypeId ?? '')?.priceCents ?? 0;
  const selectedTotal = selected.reduce((sum, id) => sum + priceOf(id), 0);
  const selectedFee = selected.length * map.bookingFeeCentsPerSeat;
  const picking = hold === null && concert.onSale;

  return (
    <section className="checkout-page">
      <header className="checkout-head">
        <p className="eyebrow">{concert.artist}</p>
        <h1>{concert.title}</h1>
        <p className="muted">
          {formatConcertDate(concert.startsAt)} · {concert.venueName}
        </p>
      </header>

      {!concert.onSale && hold === null && (
        <p className="checkout-notice glass">
          {concert.status === 'cancelled' ? 'This concert has been cancelled.' : 'Tickets are not on sale right now.'}
        </p>
      )}
      {notice && (
        <p className="checkout-notice glass" role="alert">
          {notice}
        </p>
      )}

      <div className="checkout-layout">
        <div className="card seat-map">
          <div className="stage">Stage</div>
          {map.sections.map((section) => (
            <div key={section.id} className="seat-section">
              <h3>{section.name}</h3>
              {section.rows.map((row) => (
                <div key={row.id} className="seat-row">
                  <span className="row-label">{row.label}</span>
                  {row.seats.map((seat) => {
                    const isSelected = selected.includes(seat.id);
                    const type = ticketTypes.get(seat.ticketTypeId);
                    const free = seat.status === 'available';
                    return (
                      <button
                        key={seat.id}
                        type="button"
                        className={`seat tt-${type?.colour ?? 0} ${seat.status} ${isSelected ? 'selected' : ''}`}
                        disabled={!picking || !free || busy}
                        aria-pressed={isSelected}
                        title={`${seatInfo.get(seat.id)?.label} · ${type?.name ?? ''} · ${seat.status}`}
                        onClick={() => toggleSeat(seat.id)}
                      >
                        {seat.seatNumber}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
          <div className="seat-legend">
            {map.ticketTypes.map((t, i) => (
              <span key={t.id}>
                <i className={`seat tt-${i % 4}`} /> {t.name} {formatMoney(t.priceCents, t.currency)}
              </span>
            ))}
            <span>
              <i className="seat yours" /> Your hold
            </span>
            <span>
              <i className="seat held" /> Taken
            </span>
          </div>
        </div>

        <aside className="card checkout-summary">
          {hold ? (
            <>
              <p className="eyebrow">Seats on hold</p>
              {holdRanOut ? (
                <p className="countdown expired">Hold expired</p>
              ) : (
                <p className="countdown" aria-live="polite">
                  {formatCountdown(remainingMs)}
                </p>
              )}
              <OrderLines order={hold} />
              {holdRanOut ? (
                <button type="button" onClick={() => void load()} disabled={busy}>
                  Pick seats again
                </button>
              ) : (
                <div className="stack">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={simulateFailure}
                      onChange={(e) => setSimulateFailure(e.target.checked)}
                    />
                    Simulate a failed payment (demo)
                  </label>
                  <button type="button" onClick={() => void pay()} disabled={busy}>
                    Pay {formatMoney(hold.totalCents, hold.currency)}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => void release()} disabled={busy}>
                    Release seats
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="eyebrow">Your seats</p>
              {selected.length === 0 ? (
                <p className="muted small">Pick seats on the map. They'll be held for 10 minutes while you pay.</p>
              ) : (
                <ul className="order-lines">
                  {selected.map((id) => {
                    const type = ticketTypes.get(seatInfo.get(id)?.ticketTypeId ?? '');
                    return (
                      <li key={id}>
                        <span>
                          {seatInfo.get(id)?.label}
                          <small>{type?.name}</small>
                        </span>
                        <span>{formatMoney(type?.priceCents ?? 0, currency)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Totals subtotal={selectedTotal} fee={selectedFee} currency={currency} />
              <button
                type="button"
                onClick={() => void holdSeats()}
                disabled={!picking || busy || selected.length === 0}
              >
                Hold {selected.length || ''} seat{selected.length === 1 ? '' : 's'} for 10 minutes
              </button>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function OrderLines({ order }: { order: Hold }) {
  return (
    <>
      <ul className="order-lines">
        {order.seats.map((s) => (
          <li key={s.seatId}>
            <span>
              {s.section} · Row {s.row} · Seat {s.seatNumber}
              <small>{s.ticketType}</small>
            </span>
            <span>{formatMoney(s.priceCents, order.currency)}</span>
          </li>
        ))}
      </ul>
      <Totals subtotal={order.subtotalCents} fee={order.bookingFeeCents} currency={order.currency} />
    </>
  );
}

function Totals({ subtotal, fee, currency }: { subtotal: number; fee: number; currency: string }) {
  return (
    <dl className="totals">
      <dt>Subtotal</dt>
      <dd>{formatMoney(subtotal, currency)}</dd>
      <dt>Booking fee</dt>
      <dd>{formatMoney(fee, currency)}</dd>
      <dt className="total">Total</dt>
      <dd className="total">{formatMoney(subtotal + fee, currency)}</dd>
    </dl>
  );
}
