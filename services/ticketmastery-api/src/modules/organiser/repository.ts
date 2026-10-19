import type { Queryable } from '../../db/pool';
import type { CreateConcertInput, ReplaceTicketTypesInput } from './schemas';

export type ConcertStatus = 'draft' | 'scheduled' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';

export interface ConcertRow {
  id: string;
  organiser_id: string;
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
  layout_locked: boolean;
  layout_locked_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketTypeRow {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  quantity: number;
  max_per_order: number;
  sort_order: number;
  seat_count: number;
}

export interface SectionSummaryRow {
  id: string;
  name: string;
  sort_order: number;
  row_count: number;
  seat_count: number;
}

export interface DashboardRow {
  ticket_type_id: string;
  name: string;
  price_cents: number;
  currency: string;
  quantity: number;
  available: number;
  held_active: number;
  held_expired: number;
  sold: number;
  total: number;
}

/** `layout_locked` uses the same SQL predicate as the DB triggers, so code and triggers cannot disagree. */
const CONCERT_COLUMNS = `
  c.id, c.organiser_id, c.title, c.artist, c.description, c.venue_name, c.venue_address,
  c.starts_at, c.ends_at, c.sale_starts_at, c.sale_ends_at, c.status,
  concert_layout_locked(c.status, c.sale_starts_at, c.layout_locked_at) AS layout_locked,
  c.layout_locked_at, c.cancelled_at, c.cancellation_reason, c.image_url, c.created_at, c.updated_at`;

export async function insertConcert(db: Queryable, organiserId: string, input: CreateConcertInput) {
  const { rows } = await db.query<ConcertRow>(
    `INSERT INTO concerts AS c (organiser_id, title, artist, description, venue_name, venue_address,
                                starts_at, ends_at, sale_starts_at, sale_ends_at, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${CONCERT_COLUMNS}`,
    [
      organiserId,
      input.title,
      input.artist,
      input.description ?? null,
      input.venueName,
      input.venueAddress ?? null,
      input.startsAt,
      input.endsAt ?? null,
      input.saleStartsAt,
      input.saleEndsAt,
      input.imageUrl ?? null,
    ],
  );
  return rows[0]!;
}

export async function listConcertsByOrganiser(db: Queryable, organiserId: string) {
  const { rows } = await db.query<ConcertRow>(
    `SELECT ${CONCERT_COLUMNS} FROM concerts c WHERE c.organiser_id = $1 ORDER BY c.starts_at DESC, c.id`,
    [organiserId],
  );
  return rows;
}

export async function findConcertByOrganiserAndTitle(db: Queryable, organiserId: string, title: string) {
  const { rows } = await db.query<ConcertRow>(
    `SELECT ${CONCERT_COLUMNS} FROM concerts c WHERE c.organiser_id = $1 AND c.title = $2 ORDER BY c.created_at LIMIT 1`,
    [organiserId, title],
  );
  return rows[0];
}

/** `forUpdate` row-locks the concert so concurrent layout/ticket-type/publish/cancel calls serialise. */
export async function findConcert(db: Queryable, id: string, forUpdate: boolean) {
  const { rows } = await db.query<ConcertRow>(
    `SELECT ${CONCERT_COLUMNS} FROM concerts c WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0];
}

export async function listTicketTypes(db: Queryable, concertId: string) {
  const { rows } = await db.query<TicketTypeRow>(
    `SELECT tt.id, tt.name, tt.description, tt.price_cents, tt.currency, tt.quantity, tt.max_per_order,
            tt.sort_order, (SELECT count(*)::int FROM seats s WHERE s.ticket_type_id = tt.id) AS seat_count
       FROM ticket_types tt
      WHERE tt.concert_id = $1
      ORDER BY tt.sort_order, tt.name`,
    [concertId],
  );
  return rows;
}

export async function deleteTicketTypes(db: Queryable, ids: string[]) {
  await db.query('DELETE FROM ticket_types WHERE id = ANY($1::uuid[])', [ids]);
}

/** Inserts new ticket types and updates existing ones (matched by name, so seat FKs keep pointing at them). */
export async function upsertTicketTypes(
  db: Queryable,
  concertId: string,
  ticketTypes: ReplaceTicketTypesInput['ticketTypes'],
) {
  await db.query(
    `INSERT INTO ticket_types (concert_id, name, description, price_cents, currency, quantity, max_per_order, sort_order)
     SELECT $1, t.name, t.description, t.price_cents, t.currency, t.quantity, t.max_per_order, t.sort_order
       FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::int[], $7::int[], $8::int[])
            AS t(name, description, price_cents, currency, quantity, max_per_order, sort_order)
     ON CONFLICT (concert_id, name) DO UPDATE
        SET description = EXCLUDED.description, price_cents = EXCLUDED.price_cents, currency = EXCLUDED.currency,
            quantity = EXCLUDED.quantity, max_per_order = EXCLUDED.max_per_order, sort_order = EXCLUDED.sort_order`,
    [
      concertId,
      ticketTypes.map((t) => t.name),
      ticketTypes.map((t) => t.description ?? null),
      ticketTypes.map((t) => t.priceCents),
      ticketTypes.map((t) => t.currency),
      ticketTypes.map((t) => t.quantity),
      ticketTypes.map((t) => t.maxPerOrder),
      ticketTypes.map((_, i) => i),
    ],
  );
}

export async function countUnavailableSeats(db: Queryable, concertId: string) {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM seats WHERE concert_id = $1 AND status <> 'available'`,
    [concertId],
  );
  return rows[0]!.n;
}

/** Removes sections; rows and seats go with them via ON DELETE CASCADE. */
export async function deleteLayout(db: Queryable, concertId: string) {
  await db.query('DELETE FROM sections WHERE concert_id = $1', [concertId]);
}

export async function insertSections(db: Queryable, concertId: string, names: string[]) {
  const { rows } = await db.query<{ id: string; name: string }>(
    `INSERT INTO sections (concert_id, name, sort_order)
     SELECT $1, s.name, s.ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS s(name, ord)
     RETURNING id, name`,
    [concertId, names],
  );
  return rows;
}

export async function insertRows(db: Queryable, rowsToInsert: { sectionId: string; label: string; sortOrder: number }[]) {
  const { rows } = await db.query<{ id: string; section_id: string; label: string }>(
    `INSERT INTO rows (section_id, label, sort_order)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[])
     RETURNING id, section_id, label`,
    [rowsToInsert.map((r) => r.sectionId), rowsToInsert.map((r) => r.label), rowsToInsert.map((r) => r.sortOrder)],
  );
  return rows;
}

/** Single round trip for the whole seat map (arrays are bound as parameters, not string-built SQL). */
export async function insertSeats(
  db: Queryable,
  concertId: string,
  seats: { sectionId: string; rowId: string; ticketTypeId: string; seatNumber: string }[],
) {
  const result = await db.query(
    `INSERT INTO seats (concert_id, section_id, row_id, ticket_type_id, seat_number)
     SELECT $1, s.section_id, s.row_id, s.ticket_type_id, s.seat_number
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[]) AS s(section_id, row_id, ticket_type_id, seat_number)`,
    [
      concertId,
      seats.map((s) => s.sectionId),
      seats.map((s) => s.rowId),
      seats.map((s) => s.ticketTypeId),
      seats.map((s) => s.seatNumber),
    ],
  );
  return result.rowCount ?? 0;
}

export async function listSectionSummaries(db: Queryable, concertId: string) {
  const { rows } = await db.query<SectionSummaryRow>(
    `SELECT sec.id, sec.name, sec.sort_order,
            (SELECT count(*)::int FROM rows r WHERE r.section_id = sec.id) AS row_count,
            (SELECT count(*)::int FROM seats s WHERE s.section_id = sec.id) AS seat_count
       FROM sections sec
      WHERE sec.concert_id = $1
      ORDER BY sec.sort_order, sec.name`,
    [concertId],
  );
  return rows;
}

export async function publishConcert(db: Queryable, id: string) {
  const { rows } = await db.query<ConcertRow>(
    `UPDATE concerts c SET status = 'scheduled' WHERE c.id = $1 RETURNING ${CONCERT_COLUMNS}`,
    [id],
  );
  return rows[0]!;
}

export async function cancelConcert(db: Queryable, id: string, reason: string) {
  const { rows } = await db.query<ConcertRow>(
    `UPDATE concerts c
        SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2,
            layout_locked_at = COALESCE(c.layout_locked_at, now())
      WHERE c.id = $1
      RETURNING ${CONCERT_COLUMNS}`,
    [id, reason],
  );
  return rows[0]!;
}

/** Live counts per ticket type; ticket types without seats yet still appear with zeros. */
export async function dashboardCounts(db: Queryable, concertId: string) {
  const { rows } = await db.query<DashboardRow>(
    `SELECT tt.id AS ticket_type_id, tt.name, tt.price_cents, tt.currency, tt.quantity,
            COALESCE(c.available, 0)::int    AS available,
            COALESCE(c.held_active, 0)::int  AS held_active,
            COALESCE(c.held_expired, 0)::int AS held_expired,
            COALESCE(c.sold, 0)::int         AS sold,
            COALESCE(c.total, 0)::int        AS total
       FROM ticket_types tt
       LEFT JOIN concert_seat_counts c ON c.concert_id = tt.concert_id AND c.ticket_type_id = tt.id
      WHERE tt.concert_id = $1
      ORDER BY tt.sort_order, tt.name`,
    [concertId],
  );
  return rows;
}
