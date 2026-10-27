import { ApiError } from '../../api/client';

/** Response shapes of /api/organiser (services/ticketmastery-api/src/modules/organiser/README.md). */

export type ConcertStatus = 'draft' | 'scheduled' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';

export interface OrganiserConcert {
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
  /** Ticket types and layout can no longer change (sale started, or on sale/finished/cancelled). */
  layoutLocked: boolean;
  cancelledAt: string | null;
  cancellationReason: string | null;
  imageUrl: string | null;
}

export interface OrganiserTicketType {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  quantity: number;
  maxPerOrder: number;
  sortOrder: number;
  /** Seats in the current layout that use this type; must equal `quantity` to publish. */
  seatCount: number;
}

/** GET /api/organiser/concerts/:id */
export interface OrganiserConcertDetail extends OrganiserConcert {
  ticketTypes: OrganiserTicketType[];
  layout: {
    sections: { id: string; name: string; rowCount: number; seatCount: number }[];
    totals: { sections: number; rows: number; seats: number };
  };
}

/** GET /api/organiser/concerts/:id/dashboard */
export interface Dashboard {
  status: ConcertStatus;
  generatedAt: string;
  ticketTypes: {
    ticketTypeId: string;
    name: string;
    priceCents: number;
    currency: string;
    quantity: number;
    available: number;
    held: number;
    sold: number;
    total: number;
    revenueCents: number;
  }[];
  totals: { available: number; held: number; sold: number; total: number; revenueCents: number };
}

export const STATUS_LABELS: Record<ConcertStatus, string> = {
  draft: 'Draft',
  scheduled: 'Published',
  on_sale: 'On sale',
  sold_out: 'Sold out',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

export function formatPrice(cents: number, currency = 'SGD') {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-SG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** ISO string -> value for <input type="datetime-local"> (local time, minute precision). */
export function toLocalInput(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Turns an API error into a headline plus bullet points, so organisers see *why* a save failed
 * (field validation, layout problems, seat counts that do not match ticket quantities).
 */
export function describeError(e: unknown): { message: string; items: string[] } {
  if (!(e instanceof ApiError)) return { message: (e as Error).message, items: [] };
  const items: string[] = [];
  const d = e.details as
    | { path: string; message: string }[]
    | { problems?: string[]; quantityMismatches?: { ticketType: string; quantity: number; seatsInLayout: number }[] }
    | undefined;
  if (Array.isArray(d)) {
    items.push(...d.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)));
  } else if (d) {
    items.push(...(d.problems ?? []));
    items.push(
      ...(d.quantityMismatches ?? []).map(
        (m) => `${m.ticketType}: quantity is ${m.quantity} but the layout has ${m.seatsInLayout} seats`,
      ),
    );
  }
  return { message: e.message, items };
}
