/**
 * Shapes returned by the UC2 API (services/ticketmastery-api/src/modules/account/). One e-ticket per order, so a
 * ticket id is the order id. Field names follow UC4's OrderConfirmed event.
 */
export interface TicketSeat {
  section: string;
  row: string;
  seatNumber: string;
  ticketType: string;
  priceCents: number;
}

export interface Order {
  orderId: string;
  confirmedAt: string;
  currency: string;
  subtotalCents: number;
  bookingFeeCents: number;
  totalCents: number;
  concert: {
    id: string;
    title: string;
    artist: string;
    venueName: string;
    startsAt: string;
    imageUrl: string | null;
    /** The concert's current status: an organiser can cancel it after the order was confirmed. */
    status: string;
  };
  /** In seat-map order (section, row, seat). */
  seats: TicketSeat[];
}

export const isCancelled = (order: Order) => order.concert.status === 'cancelled';

export function formatTicketDate(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase(),
    time: d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' }).toUpperCase(),
  };
}

export function formatSeat(seat: TicketSeat) {
  return `${seat.section} · Row ${seat.row} · Seat ${seat.seatNumber}`;
}

export function formatSeatCount(seats: TicketSeat[]) {
  return seats.length === 1 ? '1 seat' : `${seats.length} seats`;
}

/** Short order number for people (the full id is in the URL and on the PDF). */
export const shortOrderId = (orderId: string) => orderId.slice(0, 8).toUpperCase();

export function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(cents / 100);
}
