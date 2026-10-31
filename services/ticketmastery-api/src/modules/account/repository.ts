import type { Queryable } from '../../db/pool';

/** Mirrors the concert_status enum in 0001 (kept here: modules don't import from each other). */
export type ConcertStatus = 'draft' | 'scheduled' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';

/** One seat of an order, with the ticket type and price at hold time (UC4's order_items). */
export interface TicketSeat {
  section: string;
  row: string;
  seatNumber: string;
  ticketType: string;
  priceCents: number;
}

export interface MyOrderRow {
  id: string;
  currency: string;
  subtotal_cents: number;
  booking_fee_cents: number;
  total_cents: number;
  confirmed_at: Date;
  concert_id: string;
  title: string;
  artist: string;
  venue_name: string;
  starts_at: Date;
  image_url: string | null;
  /** The concert's own status: an organiser can cancel it after the order was confirmed. */
  concert_status: ConcertStatus;
  /** Built by Postgres, in seat-map order (section, row, seat). */
  seats: TicketSeat[];
}

/** Order history is short for a fan; a cap keeps one response bounded without paging. */
export const MAX_ORDERS = 100;

/*
 * Only confirmed orders: pending, cancelled and expired orders are checkout attempts that never became tickets.
 * Every query filters by fan_id = the caller's Cognito `sub` from the verified token, never a value from the URL.
 */
const MY_ORDERS = `
  SELECT o.id, o.currency, o.subtotal_cents, o.booking_fee_cents, o.total_cents, o.confirmed_at,
         c.id AS concert_id, c.title, c.artist, c.venue_name, c.starts_at, c.image_url, c.status AS concert_status,
         COALESCE((
           SELECT json_agg(json_build_object('section', sec.name, 'row', r.label, 'seatNumber', s.seat_number,
                                             'ticketType', tt.name, 'priceCents', oi.price_cents)
                           ORDER BY sec.sort_order, r.sort_order, s.seat_number)
             FROM order_items oi
             JOIN seats s         ON s.id = oi.seat_id
             JOIN ticket_types tt ON tt.id = oi.ticket_type_id
             JOIN sections sec    ON sec.id = s.section_id
             JOIN rows r          ON r.id = s.row_id
            WHERE oi.order_id = o.id
         ), '[]'::json) AS seats
    FROM orders o
    JOIN concerts c ON c.id = o.concert_id
   WHERE o.fan_id = $1 AND o.status = 'confirmed'`;

/** The caller's tickets, newest first (orders_fan_idx). */
export async function listMyOrders(db: Queryable, fanId: string): Promise<MyOrderRow[]> {
  const { rows } = await db.query<MyOrderRow>(`${MY_ORDERS} ORDER BY o.created_at DESC, o.id LIMIT $2`, [
    fanId,
    MAX_ORDERS,
  ]);
  return rows;
}

/** One confirmed order, only if it belongs to the caller. */
export async function findMyOrder(db: Queryable, fanId: string, orderId: string): Promise<MyOrderRow | undefined> {
  const { rows } = await db.query<MyOrderRow>(`${MY_ORDERS} AND o.id = $2`, [fanId, orderId]);
  return rows[0];
}
