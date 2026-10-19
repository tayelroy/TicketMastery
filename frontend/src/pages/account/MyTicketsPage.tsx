import { Link } from 'react-router-dom';
import { formatTicketDate, SAMPLE_TICKETS } from './sampleTickets';
import './tickets.css';

export function MyTicketsPage() {
  return (
    <section className="tickets-page">
      <h1 className="tickets-heading">My Tickets</h1>

      <p className="tickets-notice glass">
        Preview: <code>GET /api/me/orders</code> is not built yet (owner: Andrew), so this is sample data.
      </p>

      <div className="ticket-list">
        {SAMPLE_TICKETS.map((t) => {
          const { date, time } = formatTicketDate(t.startsAt);
          return (
            <Link key={t.id} to={`/myaccount/tickets/${t.id}`} className="ticket-row glass">
              <div className="ticket-thumb">{t.imageUrl && <img src={t.imageUrl} alt="" />}</div>
              <div className="ticket-row-info">
                <strong>{t.concertTitle}</strong>
                <small>
                  {date} · {time}
                </small>
                <small>{t.venueName}</small>
              </div>
              <span className="ticket-row-cta">View ticket ›</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
