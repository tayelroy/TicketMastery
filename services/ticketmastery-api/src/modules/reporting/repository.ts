import type { Queryable } from '../../db/pool';

// Every query here reads only the five report_* views (migrations/0003): the reporting ECS service connects as
// reporting_ro (0004), which has SELECT on those views and nothing else, not even `concerts`. Concert details come
// from report_sales_by_concert (title, artist, venue, start, status of concerts with sales) or report_seat_status
// (title, start, status, organiser of every concert, drafts included). test/reporting.test.ts runs each one under
// SET LOCAL ROLE reporting_ro.
// Sums of cents come back as bigint, which node-postgres returns as strings; the service converts them.

export type ConcertStatus = 'draft' | 'scheduled' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';

/** Owner of any concert (drafts included); undefined if there is no such concert. */
export async function findConcertOrganiser(db: Queryable, concertId: string) {
  const { rows } = await db.query<{ organiser_id: string }>(
    'SELECT s.organiser_id FROM report_seat_status s WHERE s.concert_id = $1',
    [concertId],
  );
  return rows[0]?.organiser_id;
}

/** Organiser, optional concert and Singapore date range (from null = since the first sale), as query params. */
export interface ReportFilter {
  organiserId: string;
  concertId: string | null;
  from: string | null;
  to: string;
}

const filterParams = (f: ReportFilter) => [f.organiserId, f.concertId, f.from, f.to];

/** Confirmed orders of the organiser in the range, as a WHERE clause over report_confirmed_orders `r`. */
const CONFIRMED_IN_RANGE = `r.organiser_id = $1 AND ($2::uuid IS NULL OR r.concert_id = $2)
  AND r.sale_date_sgt BETWEEN COALESCE($3::date, '-infinity'::date) AND $4::date`;

export interface ReportTotalsRow {
  currency: string;
  confirmed_orders: number;
  seats_sold: number;
  ticket_revenue_cents: string;
  booking_fee_cents: string;
  gross_revenue_cents: string;
}

export async function reportTotals(db: Queryable, f: ReportFilter) {
  const { rows } = await db.query<ReportTotalsRow>(
    `SELECT r.currency, count(*)::int AS confirmed_orders, sum(r.seats)::int AS seats_sold,
            sum(r.ticket_revenue_cents)::bigint AS ticket_revenue_cents,
            sum(r.booking_fee_cents)::bigint    AS booking_fee_cents,
            sum(r.gross_revenue_cents)::bigint  AS gross_revenue_cents
       FROM report_confirmed_orders r
      WHERE ${CONFIRMED_IN_RANGE}
      GROUP BY r.currency
      ORDER BY r.currency`,
    filterParams(f),
  );
  return rows;
}

export interface ReportByConcertRow extends ReportTotalsRow {
  concert_id: string;
  title: string;
  artist: string;
  venue_name: string;
  starts_at: Date;
  status: ConcertStatus;
}

/**
 * Sums in the range per concert and currency. The concert details come from report_sales_by_concert's all-time row
 * for the same concert and currency, which exists for every (concert, currency) with a confirmed order.
 */
export async function reportByConcert(db: Queryable, f: ReportFilter) {
  const { rows } = await db.query<ReportByConcertRow>(
    `WITH in_range AS (
       SELECT r.concert_id, r.currency, count(*)::int AS confirmed_orders, sum(r.seats)::int AS seats_sold,
              sum(r.ticket_revenue_cents)::bigint AS ticket_revenue_cents,
              sum(r.booking_fee_cents)::bigint    AS booking_fee_cents,
              sum(r.gross_revenue_cents)::bigint  AS gross_revenue_cents
         FROM report_confirmed_orders r
        WHERE ${CONFIRMED_IN_RANGE}
        GROUP BY r.concert_id, r.currency
     )
     SELECT x.concert_id, c.concert_title AS title, c.artist, c.venue_name, c.concert_starts_at AS starts_at,
            c.concert_status AS status, x.currency, x.confirmed_orders, x.seats_sold, x.ticket_revenue_cents,
            x.booking_fee_cents, x.gross_revenue_cents
       FROM in_range x
       JOIN report_sales_by_concert c ON c.concert_id = x.concert_id AND c.currency = x.currency
      ORDER BY x.gross_revenue_cents DESC, c.concert_title, x.concert_id, x.currency`,
    filterParams(f),
  );
  return rows;
}

export interface ReportByDayRow {
  date: string;
  currency: string;
  confirmed_orders: number;
  seats_sold: number;
  gross_revenue_cents: string;
}

/**
 * One row per Singapore day from `from` (or the first sale in the filter) to `to`, per currency with sales in the
 * range; days without sales are zero. No sales at all gives no rows.
 */
export async function reportByDay(db: Queryable, f: ReportFilter) {
  const { rows } = await db.query<ReportByDayRow>(
    `WITH sales AS (
       SELECT d.sale_date, d.currency, sum(d.confirmed_orders) AS orders, sum(d.seats_sold) AS seats,
              sum(d.gross_revenue_cents) AS gross
         FROM report_sales_by_day d
        WHERE d.organiser_id = $1 AND ($2::uuid IS NULL OR d.concert_id = $2)
          AND d.sale_date BETWEEN COALESCE($3::date, '-infinity'::date) AND $4::date
        GROUP BY d.sale_date, d.currency
     )
     SELECT to_char(g.day, 'YYYY-MM-DD') AS date, cur.currency,
            COALESCE(s.orders, 0)::int AS confirmed_orders, COALESCE(s.seats, 0)::int AS seats_sold,
            COALESCE(s.gross, 0)::bigint AS gross_revenue_cents
       FROM (SELECT DISTINCT currency FROM sales) cur
      CROSS JOIN LATERAL generate_series(
              COALESCE($3::date, (SELECT min(sale_date) FROM sales)), $4::date, interval '1 day') AS g(day)
       LEFT JOIN sales s ON s.sale_date = g.day::date AND s.currency = cur.currency
      ORDER BY g.day, cur.currency`,
    filterParams(f),
  );
  return rows;
}

export interface ReportByTicketTypeRow {
  concert_id: string;
  concert_title: string;
  ticket_type_name: string;
  currency: string;
  confirmed_orders: number;
  seats_sold: number;
  ticket_revenue_cents: string;
}

/** All time: the view has no date (an order's seats can only be dated through the order). */
export async function reportByTicketType(db: Queryable, organiserId: string, concertId: string | null) {
  const { rows } = await db.query<ReportByTicketTypeRow>(
    `SELECT t.concert_id, t.concert_title, t.ticket_type_name, t.currency, t.confirmed_orders::int AS confirmed_orders,
            t.seats_sold::int AS seats_sold, t.ticket_revenue_cents::bigint AS ticket_revenue_cents
       FROM report_sales_by_ticket_type t
      WHERE t.organiser_id = $1 AND ($2::uuid IS NULL OR t.concert_id = $2)
      ORDER BY t.concert_title, t.concert_id, t.ticket_type_sort_order, t.ticket_type_name, t.currency`,
    [organiserId, concertId],
  );
  return rows;
}

export interface ReportSeatStatusRow {
  concert_id: string;
  title: string;
  starts_at: Date;
  status: ConcertStatus;
  available: number;
  held: number;
  sold: number;
  total: number;
}

/** Current counts for every concert of the organiser, drafts included. */
export async function reportSeatStatus(db: Queryable, organiserId: string, concertId: string | null) {
  const { rows } = await db.query<ReportSeatStatusRow>(
    `SELECT s.concert_id, s.concert_title AS title, s.concert_starts_at AS starts_at, s.concert_status AS status,
            s.available::int AS available, s.held::int AS held, s.sold::int AS sold, s.total::int AS total
       FROM report_seat_status s
      WHERE s.organiser_id = $1 AND ($2::uuid IS NULL OR s.concert_id = $2)
      ORDER BY s.concert_starts_at, s.concert_title, s.concert_id`,
    [organiserId, concertId],
  );
  return rows;
}

export interface ReportRecentOrderRow {
  order_id: string;
  concert_id: string;
  concert_title: string;
  seats: number;
  gross_revenue_cents: number;
  currency: string;
  confirmed_at: Date;
}

export const RECENT_ORDERS_LIMIT = 50;

/** Newest confirmed orders in the range, titled from report_seat_status; the views carry no fan identity. */
export async function reportRecentOrders(db: Queryable, f: ReportFilter) {
  const { rows } = await db.query<ReportRecentOrderRow>(
    `SELECT r.order_id, r.concert_id, s.concert_title, r.seats::int AS seats,
            r.gross_revenue_cents, r.currency, r.confirmed_at
       FROM report_confirmed_orders r
       JOIN report_seat_status s ON s.concert_id = r.concert_id
      WHERE ${CONFIRMED_IN_RANGE}
      ORDER BY r.confirmed_at DESC, r.order_id
      LIMIT ${RECENT_ORDERS_LIMIT}`,
    filterParams(f),
  );
  return rows;
}
