import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { formatConcertDate, formatMoney, type Hold, type SeatMap } from './types';
import './checkout.css';

/** Same cap as the API (MAX_SEATS_PER_HOLD); the per-ticket-type limit comes from the seat map. */
const MAX_SEATS_PER_HOLD = 20;

/**
 * A seat click refreshes the seat map first if it is older than this, so a fan who paused finds out a seat was
 * taken when they pick it, not at Checkout. 20 s: a fan picking several seats clicks every few seconds, so a
 * burst stays inside one window (no extra waiting), while anyone who stopped to browse or decide gets fresh
 * data on their next click. It also caps refreshes at 3 a minute per fan during an on-sale spike. Checkout
 * still has the final say: a seat taken within the window is caught there (seats_unavailable).
 */
const STALE_SEAT_MAP_MS = 20_000;

/** Friendly text for the API's error codes; anything else shows the API's own message. */
const ERROR_TEXT: Record<string, string> = {
  seats_unavailable: 'Some of those seats were just taken. The seat map has been refreshed, please select again.',
  active_hold_exists: 'You already have seats reserved for this concert.',
  not_on_sale: 'Tickets for this concert are not on sale right now.',
  not_admitted: 'You need to go through the waiting room first.',
  too_many_seats: 'That is more seats of one ticket type than a single order allows.',
  hold_cancelled: 'That reservation was already cancelled. Please select your seats again.',
  payment_failed: 'Payment was declined and your seats were released. Please select again.',
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

/** Re-renders every second while `active`, for the reservation countdown. */
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
  // Mirrors `selected` so a click that waits for a refresh sees picks made meanwhile, not a stale closure.
  const selectedRef = useRef<string[]>([]);
  const lastLoadedAt = useRef(0);
  const refreshing = useRef<Promise<SeatMap | null> | null>(null);
  const [hold, setHold] = useState<Hold | null>(null);
  const [confirmed, setConfirmed] = useState<Hold | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  const updateSelected = (next: string[]) => {
    selectedRef.current = next;
    setSelected(next);
  };

  const seatMapPath = `/api/checkout/concerts/${encodeURIComponent(concertId)}/seats`;

  const load = useCallback(async () => {
    try {
      const next = await api<SeatMap>(seatMapPath);
      setMap(next);
      setHold(next.activeHold);
      selectedRef.current = [];
      setSelected([]);
      lastLoadedAt.current = Date.now();
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 404 ? 'Concert not found.' : 'Could not load the seats.');
    }
  }, [seatMapPath]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Fetches the seat map again but keeps the fan's selection (unlike load). Concurrent calls share one request.
   * Returns null if it fails; the current map stays and Checkout still checks the seats.
   */
  function refreshSeats(): Promise<SeatMap | null> {
    refreshing.current ??= (async () => {
      try {
        const next = await api<SeatMap>(seatMapPath);
        setMap(next);
        lastLoadedAt.current = Date.now();
        // Reserved in another tab meanwhile: go straight to that checkout.
        if (next.activeHold) setHold(next.activeHold);
        return next;
      } catch {
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }

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

  // The reservation ran out on this page: release it (the order is closed as 'expired' and the seats freed
  // straight away), show the seat map again and tell the fan why with the timeout popup.
  useEffect(() => {
    if (!holdRanOut || !hold) return;
    setTimedOut(true);
    void (async () => {
      try {
        await api(`/api/checkout/holds/${hold.holdId}`, { method: 'DELETE' });
      } catch {
        // Already closed on the server; the reload below shows the current state either way.
      }
      await load();
    })();
  }, [holdRanOut, hold, load]);

  /** Runs an API call with the busy flag, turning API errors into a notice (and a fresh seat map if needed). */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'hold_expired') {
        setTimedOut(true);
        await load();
      } else if (err instanceof ApiError) {
        setNotice(ERROR_TEXT[err.code] ?? err.message);
        if (RELOAD_AFTER.has(err.code)) await load();
      } else {
        setNotice('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggleSeat(seatId: string) {
    setNotice(null);
    if (selectedRef.current.includes(seatId)) {
      updateSelected(selectedRef.current.filter((id) => id !== seatId));
      return;
    }

    if (refreshing.current || Date.now() - lastLoadedAt.current > STALE_SEAT_MAP_MS) {
      const fresh = await refreshSeats();
      if (fresh) {
        const allSeats = fresh.sections.flatMap((sec) => sec.rows.flatMap((r) => r.seats));
        const free = new Set(allSeats.filter((x) => x.status === 'available').map((x) => x.id));
        const lost = selectedRef.current.filter((id) => !free.has(id));
        if (lost.length > 0) updateSelected(selectedRef.current.filter((id) => free.has(id)));
        const messages = [];
        if (!free.has(seatId)) messages.push('That seat was just taken by someone else. Please choose another.');
        if (lost.length > 0) {
          messages.push(
            `${lost.length} of your selected seat${lost.length === 1 ? ' was' : 's were'} just taken by someone else ` +
              'and removed from your selection.',
          );
        }
        if (messages.length > 0) setNotice(messages.join(' '));
        if (!free.has(seatId)) return;
      }
    }

    const current = selectedRef.current;
    const type = ticketTypes.get(seatInfo.get(seatId)?.ticketTypeId ?? '');
    const sameType = current.filter((id) => seatInfo.get(id)?.ticketTypeId === type?.id).length;
    if (type && sameType >= type.maxPerOrder) {
      setNotice(`You can pick up to ${type.maxPerOrder} ${type.name} seats per order.`);
      return;
    }
    if (current.length >= MAX_SEATS_PER_HOLD) {
      setNotice(`You can pick up to ${MAX_SEATS_PER_HOLD} seats per order.`);
      return;
    }
    updateSelected([...current, seatId]);
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
        <Steps current={2} />
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
  const picking = hold === null && concert.onSale;

  return (
    <section className="checkout-page">
      <TimeoutDialog open={timedOut} onClose={() => setTimedOut(false)} />
      <Steps current={hold ? 1 : 0} />
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

      {hold ? (
        <div className="card checkout-step">
          {holdRanOut ? (
            <div className="checkout-timer expired">
              <strong>Your reservation has expired</strong>
              <span>The seats have been released. Please select your seats again.</span>
            </div>
          ) : (
            <div className="checkout-timer" aria-live="polite">
              <span>Your seats are reserved for</span>
              <strong>{formatCountdown(remainingMs)}</strong>
              <span>Complete payment before the timer runs out.</span>
            </div>
          )}

          <h2>Order summary</h2>
          <OrderLines order={hold} />

          {holdRanOut ? (
            <div className="row">
              <button type="button" onClick={() => void load()} disabled={busy}>
                Select seats again
              </button>
            </div>
          ) : (
            <>
              <h2>Payment</h2>
              <p className="muted small">Payment is simulated for this project, so no card details are needed.</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={simulateFailure}
                  onChange={(e) => setSimulateFailure(e.target.checked)}
                />
                Simulate a declined payment (demo)
              </label>
              <div className="row">
                <button type="button" onClick={() => void pay()} disabled={busy}>
                  Pay {formatMoney(hold.totalCents, hold.currency)}
                </button>
                <button type="button" className="btn ghost" onClick={() => void release()} disabled={busy}>
                  Change seats
                </button>
              </div>
              <p className="muted small">Changing seats releases your reserved seats so others can book them.</p>
            </>
          )}
        </div>
      ) : (
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
                          onClick={() => void toggleSeat(seat.id)}
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
                <i className="seat selected" /> Selected
              </span>
              <span>
                <i className="seat held" /> Unavailable
              </span>
            </div>
          </div>

          <aside className="card checkout-summary">
            <p className="eyebrow">Order summary</p>
            {selected.length === 0 ? (
              <p className="muted small">Select seats on the map.</p>
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
            <Totals
              subtotal={selectedTotal}
              feePerSeat={map.bookingFeeCentsPerSeat}
              seats={selected.length}
              currency={currency}
            />
            <button
              type="button"
              onClick={() => void holdSeats()}
              disabled={!picking || busy || selected.length === 0}
            >
              Checkout
            </button>
            <p className="muted small">Your seats are reserved for 10 minutes while you pay.</p>
          </aside>
        </div>
      )}
    </section>
  );
}

/**
 * Centred popup shown when the 10-minute reservation runs out. Uses the native <dialog> as a modal: it dims
 * the page, keeps keyboard focus inside, and stays until the fan closes it (button or Esc).
 */
function TimeoutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="checkout-dialog" aria-labelledby="timeout-title" onClose={onClose}>
      <h2 id="timeout-title">Reservation timed out</h2>
      <p>
        Your seats were reserved for 10 minutes, and the time ran out before payment was completed. They've been
        released so other fans can book them.
      </p>
      <p>Please select your seats again to continue.</p>
      <button type="button" onClick={onClose}>
        Select seats again
      </button>
    </dialog>
  );
}

const STEPS = ['Select seats', 'Checkout', 'Confirmation'];

/** 1 Select seats → 2 Checkout → 3 Confirmation, with the current step highlighted. */
function Steps({ current }: { current: number }) {
  return (
    <ol className="checkout-steps">
      {STEPS.map((label, i) => (
        <li key={label} className={i === current ? 'current' : i < current ? 'done' : ''}>
          <span>{i + 1}</span> {label}
        </li>
      ))}
    </ol>
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
      <Totals
        subtotal={order.subtotalCents}
        feePerSeat={order.seats.length ? order.bookingFeeCents / order.seats.length : 0}
        seats={order.seats.length}
        currency={order.currency}
      />
    </>
  );
}

/** Subtotal, the booking fee shown as "per seat × seats", and the total. */
function Totals(props: { subtotal: number; feePerSeat: number; seats: number; currency: string }) {
  const { subtotal, feePerSeat, seats, currency } = props;
  const fee = feePerSeat * seats;
  return (
    <dl className="totals">
      <dt>Subtotal</dt>
      <dd>{formatMoney(subtotal, currency)}</dd>
      <dt>
        Booking fee{' '}
        <small>
          ({formatMoney(feePerSeat, currency)} × {seats})
        </small>
      </dt>
      <dd>{formatMoney(fee, currency)}</dd>
      <dt className="total">Total</dt>
      <dd className="total">{formatMoney(subtotal + fee, currency)}</dd>
    </dl>
  );
}
