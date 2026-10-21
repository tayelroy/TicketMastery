import { Link, useParams } from 'react-router-dom';
import { formatTicketDate, SAMPLE_TICKETS } from './sampleTickets';
import './tickets.css';

export function TicketDetailPage() {
  const { ticketId } = useParams();
  const ticket = SAMPLE_TICKETS.find((t) => t.id === ticketId);

  if (!ticket) {
    return (
      <section className="card">
        <h1>Ticket not found</h1>
        <div className="row">
          <Link to="/myaccount" className="btn">
            Back to my tickets
          </Link>
        </div>
      </section>
    );
  }

  const { date, time } = formatTicketDate(ticket.startsAt);

  return (
    <section className="ticket-view">
      <header className="ticket-view-head">
        <Link to="/myaccount" className="circle-btn" aria-label="Back to my tickets">
          ‹
        </Link>
        <h1>Tickets</h1>
        <span className="circle-spacer" aria-hidden="true" />
      </header>

      <div className="ticket-frame glass">
        <div className="ticket-image">{ticket.imageUrl && <img src={ticket.imageUrl} alt="" />}</div>

        <article className="eticket">
          <div className="eticket-main">
            <div className="eticket-title">
              <h2>{ticket.concertTitle}</h2>
              <p>{ticket.subtitle}</p>
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
                <dd>{ticket.venueName}</dd>
              </div>
              <div className="right">
                <dt>Seat</dt>
                <dd>{ticket.seat}</dd>
              </div>
            </dl>
          </div>
          <div className="eticket-stub">
            <div className="eticket-barcode" aria-hidden="true" />
          </div>
        </article>
      </div>

      <div className="ticket-actions">
        <button type="button" className="ghost-btn" disabled title="Not available for sample tickets">
          ⤓ Image
        </button>
        <button type="button" disabled title="Not available for sample tickets">
          ▦ QR Code
        </button>
      </div>
      <p className="muted small center">Sample ticket. Downloads come with the real API.</p>
    </section>
  );
}
