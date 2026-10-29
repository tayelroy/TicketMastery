import type { Queryable } from '../../db/pool';
import type { ConcertStatus } from '../organiser/repository';
import type { ListConcertsQuery } from './schemas';

/** Statuses fans can browse. Drafts are never public; cancelled/completed only show on the detail page. */
export const LISTED_STATUSES: ConcertStatus[] = ['scheduled', 'on_sale', 'sold_out'];

/** Public seat state: an expired hold is reclaimable by any checkout, so fans see it as available. */
export type PublicSeatStatus = 'available' | 'held' | 'sold';

export interface ConcertSummaryRow {
  id: string;
  title: string;
  artist: string;
  venue_name: string;
  starts_at: Date;
  sale_starts_at: Date;
  sale_ends_at: Date;
  status: ConcertStatus;
  image_url: string | null;
  /** Cheapest ticket type; null when no ticket types are configured yet. */
  min_price_cents: number | null;
  currency: string | null;
}

export interface ConcertDetailRow {
  id: string;
  title: string;
  artist: string;
  description: string | null;
  venue_name: string;
  venue_address: string | null;
  starts_at: Date;
  ends_at: Date | null;
  sale_starts_at: Date;
  sale_ends_at: Date;
  status: ConcertStatus;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  image_url: string | null;
}

export interface PublicTicketTypeRow {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  max_per_order: number;
  available: number;
  total: number;
}

export interface SeatMapRow {
  section_id: string;
  section_name: string;
  row_id: string;
  row_label: string;
  seat_id: string;
  seat_number: string;
  ticket_type_id: string;
  status: PublicSeatStatus;
}

/** Escapes LIKE wildcards so a search for "50%" matches the literal text. */
function containsPattern(s: string) {
  return `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listPublicConcerts(db: Queryable, filters: ListConcertsQuery) {
  const params: unknown[] = [LISTED_STATUSES, filters.from ?? new Date().toISOString()];
  const where = ['c.status = ANY($1::concert_status[])', 'c.starts_at >= $2'];
  const add = (clause: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(clause(`$${params.length}`));
  };
  if (filters.q) {
    add((p) => `(c.title ILIKE ${p} OR c.artist ILIKE ${p} OR c.venue_name ILIKE ${p})`, containsPattern(filters.q));
  }
  if (filters.artist) add((p) => `c.artist ILIKE ${p}`, containsPattern(filters.artist));
  if (filters.venue) add((p) => `c.venue_name ILIKE ${p}`, containsPattern(filters.venue));
  if (filters.to) add((p) => `c.starts_at <= ${p}`, filters.to);
  params.push(filters.limit, filters.offset);

  const { rows } = await db.query<ConcertSummaryRow>(
    `SELECT c.id, c.title, c.artist, c.venue_name, c.starts_at, c.sale_starts_at, c.sale_ends_at, c.status,
            c.image_url, p.price_cents AS min_price_cents, p.currency
       FROM concerts c
       LEFT JOIN LATERAL (
         SELECT tt.price_cents, tt.currency FROM ticket_types tt
          WHERE tt.concert_id = c.id
          ORDER BY tt.price_cents, tt.sort_order
          LIMIT 1
       ) p ON true
      WHERE ${where.join(' AND ')}
      ORDER BY c.starts_at, c.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/** Any non-draft concert, so links to a cancelled or finished show still resolve. */
export async function findPublicConcert(db: Queryable, id: string) {
  const { rows } = await db.query<ConcertDetailRow>(
    `SELECT c.id, c.title, c.artist, c.description, c.venue_name, c.venue_address, c.starts_at, c.ends_at,
            c.sale_starts_at, c.sale_ends_at, c.status, c.cancelled_at, c.cancellation_reason, c.image_url
       FROM concerts c
      WHERE c.id = $1 AND c.status <> 'draft'`,
    [id],
  );
  return rows[0];
}

/** Ticket types with live availability (same expired-hold rule as concert_seat_counts). */
export async function listPublicTicketTypes(db: Queryable, concertId: string) {
  const { rows } = await db.query<PublicTicketTypeRow>(
    `SELECT tt.id, tt.name, tt.description, tt.price_cents, tt.currency, tt.max_per_order,
            COALESCE(sc.available, 0)::int AS available,
            COALESCE(sc.total, 0)::int     AS total
       FROM ticket_types tt
       LEFT JOIN concert_seat_counts sc ON sc.concert_id = tt.concert_id AND sc.ticket_type_id = tt.id
      WHERE tt.concert_id = $1
      ORDER BY tt.sort_order, tt.name`,
    [concertId],
  );
  return rows;
}

/** Whole seat map in one query, ordered for display (numeric seat numbers sort 1, 2, ..., 10). */
export async function listSeatMap(db: Queryable, concertId: string) {
  const { rows } = await db.query<SeatMapRow>(
    `SELECT sec.id AS section_id, sec.name AS section_name, r.id AS row_id, r.label AS row_label,
            s.id AS seat_id, s.seat_number, s.ticket_type_id,
            CASE WHEN s.status = 'held' AND s.hold_expires_at < now() THEN 'available'
                 ELSE s.status::text END AS status
       FROM seats s
       JOIN sections sec ON sec.id = s.section_id
       JOIN rows r ON r.id = s.row_id
      WHERE s.concert_id = $1
      ORDER BY sec.sort_order, sec.name, r.sort_order, r.label,
               substring(s.seat_number FROM '^[0-9]+')::int NULLS LAST, s.seat_number`,
    [concertId],
  );
  return rows;
}
