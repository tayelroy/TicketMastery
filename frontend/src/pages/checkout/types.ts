/** Response shapes of /api/checkout (see services/ticketmastery-api/src/modules/checkout/README.md). */

export type SeatStatus = 'available' | 'held' | 'yours' | 'sold';

export interface Seat {
  id: string;
  seatNumber: string;
  ticketTypeId: string;
  status: SeatStatus;
}

export interface TicketType {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  maxPerOrder: number;
}

export interface Hold {
  holdId: string;
  orderId: string;
  concertId: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: string;
  currency: string;
  seats: {
    seatId: string;
    section: string;
    row: string;
    seatNumber: string;
    ticketTypeId: string;
    ticketType: string;
    priceCents: number;
  }[];
  subtotalCents: number;
  bookingFeeCents: number;
  totalCents: number;
}

export interface SeatMap {
  concert: {
    id: string;
    title: string;
    artist: string;
    venueName: string;
    startsAt: string;
    status: string;
    saleStartsAt: string;
    saleEndsAt: string;
    onSale: boolean;
  };
  bookingFeeCentsPerSeat: number;
  ticketTypes: TicketType[];
  sections: { id: string; name: string; rows: { id: string; label: string; seats: Seat[] }[] }[];
  activeHold: Hold | null;
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(cents / 100);
}

export function formatConcertDate(iso: string): string {
  return new Intl.DateTimeFormat('en-SG', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
}
