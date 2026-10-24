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

/** A seat as shown on the checkout page and in the OrderConfirmed event. */
export interface OrderSeatRow {
  id: string;
  ticket_type_id: string;
  ticket_type_name: string;
  price_cents: number;
  section_name: string;
  row_label: string;
  seat_number: string;
}

export interface SeatForHoldRow extends OrderSeatRow {
  currency: string;
  max_per_order: number;
}

/** What the e-ticket needs to say about the concert. */
export interface ConcertSummaryRow {
  id: string;
  title: string;
  artist: string;
  venue_name: string;
  starts_at: Date;
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

/**
 * The fan's order for this hold, locked FOR UPDATE so a release and a confirm of the same hold (double-click,
 * two tabs) run one after the other. `hold_expired` uses the transaction's now(), like the seat statements.
 */
export async function lockOrderByHold(db: Queryable, fanId: string, holdId: string) {
  const { rows } = await db.query<OrderRow & { hold_expired: boolean }>(
    `SELECT ${ORDER_COLUMNS}, expires_at <= now() AS hold_expired
       FROM orders
      WHERE hold_id = $1 AND fan_id = $2
      FOR UPDATE`,
    [holdId, fanId],
  );
  return rows[0];
}

/** Moves a pending order to its final status, stamping confirmed_at / cancelled_at to match. */
export async function setOrderStatus(db: Queryable, orderId: string, status: Exclude<OrderStatus, 'pending'>) {
  const { rows } = await db.query<OrderRow>(
    `UPDATE orders
        SET status = $2::order_status,
            confirmed_at = CASE WHEN $2::order_status = 'confirmed' THEN now() END,
            cancelled_at = CASE WHEN $2::order_status = 'cancelled' THEN now() END
      WHERE id = $1 AND status = 'pending'
      RETURNING ${ORDER_COLUMNS}`,
    [orderId, status],
  );
  return rows[0]!;
}

/** The order's seats with the price fixed at hold time (order_items), for responses and the event. */
export async function findOrderSeats(db: Queryable, orderId: string) {
  const { rows } = await db.query<OrderSeatRow>(
    `SELECT s.id, oi.ticket_type_id, tt.name AS ticket_type_name, oi.price_cents,
            sec.name AS section_name, r.label AS row_label, s.seat_number
       FROM order_items oi
       JOIN seats s         ON s.id = oi.seat_id
       JOIN ticket_types tt ON tt.id = oi.ticket_type_id
       JOIN sections sec    ON sec.id = s.section_id
       JOIN rows r          ON r.id = s.row_id
      WHERE oi.order_id = $1
      ORDER BY sec.sort_order, r.sort_order, s.seat_number`,
    [orderId],
  );
  return rows;
}

export async function findConcertSummary(db: Queryable, concertId: string) {
  const { rows } = await db.query<ConcertSummaryRow>(
    `SELECT id, title, artist, venue_name, starts_at FROM concerts WHERE id = $1`,
    [concertId],
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
