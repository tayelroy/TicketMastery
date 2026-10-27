import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { formatPrice, type ConcertDetail, type SeatMap, type TicketType } from './types';
import './concerts.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; concert: ConcertDetail }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

/** Seat states change during a sale, so the map refreshes while tickets are on sale. */
const SEAT_REFRESH_MS = 15_000;

/** Seat colours per ticket type (in ticket type order); held and sold seats are greyed out instead. */
const TICKET_COLOURS = ['#ffffff', '#ffd9cf', '#7cf0b4', '#ffe58a', '#b9e6ff', '#e3c8ff'];

type SaleState = 'upcoming' | 'open' | 'closed' | 'sold_out' | 'cancelled' | 'completed';

function saleState(c: ConcertDetail, now = Date.now()): SaleState {
  if (c.status === 'cancelled' || c.status === 'completed' || c.status === 'sold_out') return c.status;
  if (now < Date.parse(c.saleStartsAt)) return 'upcoming';
  if (now > Date.parse(c.saleEndsAt)) return 'closed';
  return 'open';
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ConcertDetailPage() {
  const { concertId = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    api<ConcertDetail>(`/api/concerts/${encodeURIComponent(concertId)}`)
      .then((concert) => !cancelled && setState({ kind: 'ready', concert }))
      .catch((e) => {
        if (cancelled) return;
        // 400 = not a valid concert id, which to a fan is the same as "no such concert".
        if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setState({ kind: 'not-found' });
        else setState({ kind: 'error', message: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [concertId]);

  if (state.kind === 'loading') return <div className="concert-hero skeleton" />;
  if (state.kind === 'not-found' || state.kind === 'error') {
    return (
      <section className="card">
        <h1>{state.kind === 'not-found' ? 'Concert not found' : "Couldn't load this concert"}</h1>
        {state.kind === 'error' && <p className="muted">{state.message}</p>}
        <div className="row">
          <Link to="/" className="btn">
            Back to concerts
          </Link>
        </div>
      </section>
    );
  }

  const { concert } = state;
  const sale = saleState(concert);
  const colours = new Map(concert.ticketTypes.map((t, i) => [t.id, TICKET_COLOURS[i % TICKET_COLOURS.length]!]));

  return (
    <>
      <Link to="/" className="back-link">
        ‹ All concerts
      </Link>

      <section className="concert-hero glass">
        <div className="concert-hero-image">
          {concert.imageUrl ? <img src={concert.imageUrl} alt="" /> : <div className="event-image-empty" aria-hidden="true" />}
        </div>
        <div className="concert-hero-body">
          <p className="eyebrow">{concert.artist}</p>
          <h1>{concert.title}</h1>
          <dl className="concert-facts">
            <div>
              <dt>When</dt>
              <dd>{dateTime(concert.startsAt)}</dd>
            </div>
            <div>
              <dt>Where</dt>
              <dd>
                {concert.venueName}
                {concert.venueAddress && <span className="muted small"> · {concert.venueAddress}</span>}
              </dd>
            </div>
          </dl>
          {concert.description && <p className="concert-description">{concert.description}</p>}

          <SaleBanner concert={concert} sale={sale} />
          {sale === 'open' && (
            <div className="row">
              <Link to={`/concerts/${concert.id}/waiting-room`} className="btn">
                Get tickets
              </Link>
            </div>
          )}
        </div>
      </section>

      {concert.ticketTypes.length > 0 && (
        <>
          <div className="section-head">
            <h2>Tickets</h2>
          </div>
          <ul className="ticket-types">
            {concert.ticketTypes.map((t) => (
              <TicketTypeCard key={t.id} ticketType={t} colour={colours.get(t.id)!} showAvailability={sale !== 'cancelled'} />
            ))}
          </ul>
        </>
      )}

      {sale !== 'cancelled' && sale !== 'completed' && (
        <SeatMapSection concertId={concert.id} colours={colours} live={sale === 'open'} />
      )}
    </>
  );
}

function SaleBanner({ concert, sale }: { concert: ConcertDetail; sale: SaleState }) {
  switch (sale) {
    case 'upcoming':
      return <p className="sale-banner">Tickets go on sale {dateTime(concert.saleStartsAt)}.</p>;
    case 'open':
      return <p className="sale-banner open">On sale now until {dateTime(concert.saleEndsAt)}.</p>;
    case 'closed':
      return <p className="sale-banner">Ticket sales have closed.</p>;
    case 'sold_out':
      return <p className="sale-banner">Sold out.</p>;
    case 'completed':
      return <p className="sale-banner">This show has ended.</p>;
    case 'cancelled':
      return (
        <p className="sale-banner bad">
          This concert has been cancelled{concert.cancellationReason ? `: ${concert.cancellationReason}` : '.'}
        </p>
      );
  }
}

function TicketTypeCard({ ticketType: t, colour, showAvailability }: { ticketType: TicketType; colour: string; showAvailability: boolean }) {
  return (
    <li className="ticket-type glass">
      <span className="seat-swatch" style={{ background: colour }} aria-hidden="true" />
      <div className="ticket-type-info">
        <strong>{t.name}</strong>
        {t.description && <small className="muted">{t.description}</small>}
      </div>
      <div className="ticket-type-price">
        <strong>{formatPrice(t.priceCents, t.currency)}</strong>
        {showAvailability && (
          <small className="muted">{t.available > 0 ? `${t.available} of ${t.total} left` : 'Sold out'}</small>
        )}
      </div>
    </li>
  );
}

function SeatMapSection({ concertId, colours, live }: { concertId: string; colours: Map<string, string>; live: boolean }) {
  const [seatMap, setSeatMap] = useState<SeatMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<SeatMap>(`/api/concerts/${encodeURIComponent(concertId)}/seats`)
        .then((m) => {
          if (cancelled) return;
          setSeatMap(m);
          setError(null);
        })
        .catch((e) => !cancelled && setError((e as Error).message));
    load();
    const timer = live ? setInterval(load, SEAT_REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [concertId, live]);

  if (!seatMap && !error) return null;
  if (seatMap && seatMap.sections.length === 0) return null;

  return (
    <>
      <div className="section-head">
        <h2>Seat map</h2>
        <span className="seat-legend muted small">
          <span className="seat-dot held" aria-hidden="true" /> Held
          <span className="seat-dot sold" aria-hidden="true" /> Sold
        </span>
      </div>
      {error && <p className="notice glass">Couldn't load the seat map: {error}</p>}
      {seatMap && (
        <div className="seat-map glass">
          <p className="stage">Stage</p>
          {seatMap.sections.map((section) => (
            <section key={section.id} className="seat-section">
              <h3>{section.name}</h3>
              {section.rows.map((row) => {
                const available = row.seats.filter((s) => s.status === 'available').length;
                return (
                  <div key={row.id} className="seat-row" role="img" aria-label={`Row ${row.label}: ${available} of ${row.seats.length} seats available`}>
                    <span className="seat-row-label" aria-hidden="true">
                      {row.label}
                    </span>
                    {row.seats.map((s) => (
                      <span
                        key={s.id}
                        className={`seat-dot ${s.status}`}
                        style={s.status === 'available' ? { background: colours.get(s.ticketTypeId) } : undefined}
                        title={`Row ${row.label}, seat ${s.seatNumber}: ${s.status}`}
                      />
                    ))}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
