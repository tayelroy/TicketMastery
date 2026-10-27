/** Response shapes of the UC1 API (services/ticketmastery-api/src/modules/discovery/README.md). */

export type ConcertStatus = 'scheduled' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';

/** One concert as GET /api/concerts returns it. */
export interface ConcertSummary {
  id: string;
  title: string;
  artist: string;
  venueName: string;
  startsAt: string;
  saleStartsAt: string;
  saleEndsAt: string;
  status: ConcertStatus;
  imageUrl: string | null;
  /** Cheapest ticket type; null when none are configured yet. */
  minPriceCents: number | null;
  currency: string | null;
}

export interface TicketType {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  maxPerOrder: number;
  available: number;
  total: number;
}

/** GET /api/concerts/:id */
export interface ConcertDetail {
  id: string;
  title: string;
  artist: string;
  description: string | null;
  venueName: string;
  venueAddress: string | null;
  startsAt: string;
  endsAt: string | null;
  saleStartsAt: string;
  saleEndsAt: string;
  status: ConcertStatus;
  cancelledAt: string | null;
  cancellationReason: string | null;
  imageUrl: string | null;
  ticketTypes: TicketType[];
}

export type SeatStatus = 'available' | 'held' | 'sold';

/** GET /api/concerts/:id/seats */
export interface SeatMap {
  concertId: string;
  sections: {
    id: string;
    name: string;
    rows: {
      id: string;
      label: string;
      seats: { id: string; seatNumber: string; ticketTypeId: string; status: SeatStatus }[];
    }[];
  }[];
}

export function formatPrice(cents: number, currency: string) {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}
