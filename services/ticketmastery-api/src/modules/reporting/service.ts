import { pool } from '../../db/pool';
import { HttpError } from '../../http/errors';
import * as repo from './repository';
import type { SalesReportQuery } from './schemas';

const SGT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DAY_MS = 24 * 60 * 60 * 1000;

/** Singapore calendar days, inclusive: `to` is today in Singapore, `from` is `days - 1` days earlier (null = all). */
export function reportRange(days: SalesReportQuery['days'], now = new Date()) {
  const to = SGT_DATE.format(now); // en-CA formats as YYYY-MM-DD
  if (days === 'all') return { days: null, from: null, to };
  const n = Number(days);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (n - 1) * DAY_MS).toISOString().slice(0, 10);
  return { days: n, from, to };
}

/**
 * UC5 internal reporting from the report_* views, only ever for the caller's concerts. Everything is per currency
 * and in the range, except ticket types (all time, the view has no date) and seat status (now).
 * With `concertId` the concert must be the caller's: same 404/403 as the organiser module's routes.
 */
export async function getSalesReport(organiserId: string, query: SalesReportQuery) {
  const concertId = query.concertId ?? null;
  if (concertId) {
    const owner = await repo.findConcertOrganiser(pool, concertId);
    if (owner === undefined) throw new HttpError(404, 'not_found', 'Concert not found');
    if (owner !== organiserId) throw new HttpError(403, 'forbidden', 'You do not manage this concert');
  }
  const range = reportRange(query.days);
  const filter: repo.ReportFilter = { organiserId, concertId, from: range.from, to: range.to };
  const [totals, byConcert, byDay, byTicketType, seatStatus, recentOrders] = await Promise.all([
    repo.reportTotals(pool, filter),
    repo.reportByConcert(pool, filter),
    repo.reportByDay(pool, filter),
    repo.reportByTicketType(pool, organiserId, concertId),
    repo.reportSeatStatus(pool, organiserId, concertId),
    repo.reportRecentOrders(pool, filter),
  ]);
  const money = (r: repo.ReportTotalsRow) => ({
    currency: r.currency,
    confirmedOrders: r.confirmed_orders,
    seatsSold: r.seats_sold,
    ticketRevenueCents: Number(r.ticket_revenue_cents),
    bookingFeeCents: Number(r.booking_fee_cents),
    grossRevenueCents: Number(r.gross_revenue_cents),
  });
  return {
    range,
    concertId,
    totals: totals.map((r) => ({
      ...money(r),
      averageOrderCents: Math.round(Number(r.gross_revenue_cents) / r.confirmed_orders),
    })),
    byConcert: byConcert.map((r) => ({
      concertId: r.concert_id,
      title: r.title,
      artist: r.artist,
      venueName: r.venue_name,
      startsAt: r.starts_at,
      status: r.status,
      ...money(r),
    })),
    byDay: byDay.map((r) => ({
      date: r.date,
      currency: r.currency,
      confirmedOrders: r.confirmed_orders,
      seatsSold: r.seats_sold,
      grossRevenueCents: Number(r.gross_revenue_cents),
    })),
    // All time: report_sales_by_ticket_type has no date column.
    byTicketType: byTicketType.map((r) => ({
      concertId: r.concert_id,
      concertTitle: r.concert_title,
      ticketTypeName: r.ticket_type_name,
      currency: r.currency,
      confirmedOrders: r.confirmed_orders,
      seatsSold: r.seats_sold,
      ticketRevenueCents: Number(r.ticket_revenue_cents),
    })),
    seatStatus: seatStatus.map((r) => ({
      concertId: r.concert_id,
      title: r.title,
      startsAt: r.starts_at,
      status: r.status,
      available: r.available,
      held: r.held,
      sold: r.sold,
      total: r.total,
    })),
    recentOrders: recentOrders.map((r) => ({
      orderId: r.order_id,
      concertId: r.concert_id,
      concertTitle: r.concert_title,
      seats: r.seats,
      grossRevenueCents: r.gross_revenue_cents,
      currency: r.currency,
      confirmedAt: r.confirmed_at,
    })),
  };
}
