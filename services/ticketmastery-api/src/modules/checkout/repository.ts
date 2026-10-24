import type { Queryable } from '../../db/pool';

export type OrderStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';

export interface CheckoutConcertRow {
  id: string;
  status: string;
  sale_starts_at: Date;
  sale_ends_at: Date;
  /** Evaluated by Postgres so it uses the same clock (and transaction time) as the hold UPDATE. */
  sale_open: boolean;
}

export interface SeatForHoldRow {
  id: string;
  ticket_type_id: string;
  ticket_type_name: string;
  price_cents: number;
  currency: string;
  max_per_order: number;
  section_name: string;
  row_label: string;
  seat_number: string;
}

export interface OrderRow {
  id: string;
  fan_id: string;
  concert_id: string;
  hold_id: string;
  status: OrderStatus;
  currency: string;
  subtotal_cents: number;
  booking_fee_cents: number;
  total_cents: number;
  expires_at: Date;
  created_at: Date;
}

const ORDER_COLUMNS = `id, fan_id, concert_id, hold_id, status, currency, subtotal_cents, booking_fee_cents,
  total_cents, expires_at, created_at`;

/**
 * Serialises hold requests from the same fan for the same concert until the transaction ends, so the
 * "one active hold per concert" check below cannot be raced by double-clicks or parallel tabs.
 */
export async function lockFanConcert(db: Queryable, fanId: string, concertId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`uc4-hold:${fanId}:${concertId}`]);
}

/**
 * FOR SHARE: many checkouts can read the concert at once, but an organiser cancelling it (FOR UPDATE) waits
 * for in-flight holds to commit, and holds started after the cancel see status 'cancelled'.
 */
export async function findConcertForCheckout(db: Queryable, concertId: string) {
  const { rows } = await db.query<CheckoutConcertRow>(
    `SELECT id, status, sale_starts_at, sale_ends_at,
            (now() >= sale_starts_at AND now() < sale_ends_at) AS sale_open
       FROM concerts
      WHERE id = $1
      FOR SHARE`,
    [concertId],
  );
  return rows[0];
}

/** The fan's unexpired pending order for this concert, if any. */
export async function findActivePendingOrder(db: Queryable, fanId: string, concertId: string) {
  const { rows } = await db.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders
      WHERE fan_id = $1 AND concert_id = $2 AND status = 'pending' AND expires_at > now()
      LIMIT 1`,
    [fanId, concertId],
  );
  return rows[0];
}

/** Requested seats that belong to the concert, with what's needed to price the order and show it. */
export async function findSeatsForHold(db: Queryable, concertId: string, seatIds: string[]) {
  const { rows } = await db.query<SeatForHoldRow>(
    `SELECT s.id, s.ticket_type_id, tt.name AS ticket_type_name, tt.price_cents, tt.currency, tt.max_per_order,
            sec.name AS section_name, r.label AS row_label, s.seat_number
       FROM seats s
       JOIN ticket_types tt ON tt.id = s.ticket_type_id
       JOIN sections sec    ON sec.id = s.section_id
       JOIN rows r          ON r.id = s.row_id
      WHERE s.concert_id = $1 AND s.id = ANY($2::uuid[])
      ORDER BY sec.sort_order, r.sort_order, s.seat_number`,
    [concertId, seatIds],
  );
  return rows;
}

/** Of `seatIds`, the ones another checkout currently holds or that are sold (for a helpful 409). */
export async function findUnavailableSeatIds(db: Queryable, concertId: string, seatIds: string[]) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM seats
      WHERE concert_id = $1 AND id = ANY($2::uuid[])
        AND NOT (status = 'available' OR (status = 'held' AND hold_expires_at < now()))`,
    [concertId, seatIds],
  );
  return rows.map((r) => r.id);
}

export async function insertPendingOrder(
  db: Queryable,
  order: {
    fanId: string;
    concertId: string;
    holdId: string;
    currency: string;
    subtotalCents: number;
    bookingFeeCents: number;
    holdMinutes: number;
  },
) {
  // now() is the transaction start time, the same instant holdSeats used, so expires_at matches the seats.
  const { rows } = await db.query<OrderRow>(
    `INSERT INTO orders (fan_id, concert_id, hold_id, currency, subtotal_cents, booking_fee_cents, total_cents,
                         expires_at)
     VALUES ($1, $2, $3, $4, $5::int, $6::int, $5::int + $6::int, now() + make_interval(mins => $7))
     RETURNING ${ORDER_COLUMNS}`,
    [
      order.fanId,
      order.concertId,
      order.holdId,
      order.currency,
      order.subtotalCents,
      order.bookingFeeCents,
      order.holdMinutes,
    ],
  );
  return rows[0]!;
}

export async function insertOrderItems(
  db: Queryable,
  orderId: string,
  items: { seatId: string; ticketTypeId: string; priceCents: number }[],
) {
  await db.query(
    `INSERT INTO order_items (order_id, seat_id, ticket_type_id, price_cents)
     SELECT $1, i.seat_id, i.ticket_type_id, i.price_cents
       FROM unnest($2::uuid[], $3::uuid[], $4::int[]) AS i(seat_id, ticket_type_id, price_cents)`,
    [orderId, items.map((i) => i.seatId), items.map((i) => i.ticketTypeId), items.map((i) => i.priceCents)],
  );
}
