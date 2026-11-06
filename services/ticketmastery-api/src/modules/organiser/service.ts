import { pool, withTransaction, type Queryable } from '../../db/pool';
import { HttpError } from '../../http/errors';
import { type ConcertCancelledEvent, organiserEvents } from './events';
import * as repo from './repository';
import type { ConcertRow, TicketTypeRow } from './repository';
import {
  MAX_SEATS_PER_LAYOUT,
  type CreateConcertInput,
  type ReplaceLayoutInput,
  type ReplaceTicketTypesInput,
  type SalesReportQuery,
} from './schemas';

function toConcertDto(c: ConcertRow) {
  return {
    id: c.id,
    organiserId: c.organiser_id,
    title: c.title,
    artist: c.artist,
    description: c.description,
    venueName: c.venue_name,
    venueAddress: c.venue_address,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    saleStartsAt: c.sale_starts_at,
    saleEndsAt: c.sale_ends_at,
    status: c.status,
    layoutLocked: c.layout_locked,
    layoutLockedAt: c.layout_locked_at,
    cancelledAt: c.cancelled_at,
    cancellationReason: c.cancellation_reason,
    imageUrl: c.image_url,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

function toTicketTypeDto(t: TicketTypeRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    priceCents: t.price_cents,
    currency: t.currency,
    quantity: t.quantity,
    maxPerOrder: t.max_per_order,
    sortOrder: t.sort_order,
    seatCount: t.seat_count,
  };
}

/**
 * Loads a concert the organiser owns: 404 if missing, 403 if someone else's.
 * 'lock' row-locks it (FOR UPDATE) for the rest of the transaction; 'edit' also 409s when the layout is
 * locked. The DB triggers enforce the same rule; this fails early with a clear message.
 */
async function loadOwnedConcert(
  db: Queryable,
  organiserId: string,
  concertId: string,
  mode: 'read' | 'lock' | 'edit',
): Promise<ConcertRow> {
  const concert = await repo.findConcert(db, concertId, mode !== 'read');
  if (!concert) {
    throw new HttpError(404, 'not_found', 'Concert not found');
  }
  if (concert.organiser_id !== organiserId) {
    throw new HttpError(403, 'forbidden', 'You do not manage this concert');
  }
  if (mode === 'edit' && concert.layout_locked) {
    throw new HttpError(
      409,
      'layout_locked',
      `Ticket types and layout are locked (status ${concert.status}, sale starts ${concert.sale_starts_at.toISOString()})`,
    );
  }
  return concert;
}

/** Ticket types whose seat count in the layout differs from their configured quantity. */
function quantityMismatches(ticketTypes: { name: string; quantity: number }[], seatsByName: Map<string, number>) {
  return ticketTypes
    .filter((t) => (seatsByName.get(t.name) ?? 0) !== t.quantity)
    .map((t) => ({ ticketType: t.name, quantity: t.quantity, seatsInLayout: seatsByName.get(t.name) ?? 0 }));
}

export async function createConcert(organiserId: string, input: CreateConcertInput) {
  return toConcertDto(await repo.insertConcert(pool, organiserId, input));
}

export async function listConcerts(organiserId: string) {
  return (await repo.listConcertsByOrganiser(pool, organiserId)).map(toConcertDto);
}

export async function getConcertDetail(organiserId: string, concertId: string) {
  const concert = await loadOwnedConcert(pool, organiserId, concertId, 'read');
  const [ticketTypes, sections] = await Promise.all([
    repo.listTicketTypes(pool, concertId),
    repo.listSectionSummaries(pool, concertId),
  ]);
  return {
    ...toConcertDto(concert),
    ticketTypes: ticketTypes.map(toTicketTypeDto),
    layout: {
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        sortOrder: s.sort_order,
        rowCount: s.row_count,
        seatCount: s.seat_count,
      })),
      totals: {
        sections: sections.length,
        rows: sections.reduce((n, s) => n + s.row_count, 0),
        seats: sections.reduce((n, s) => n + s.seat_count, 0),
      },
    },
  };
}

/**
 * Replaces the concert's ticket types. Existing types are matched by name and updated in place (seats keep
 * their FK); types missing from the new set are deleted, which is refused while seats still use them.
 */
export async function replaceTicketTypes(organiserId: string, concertId: string, input: ReplaceTicketTypesInput) {
  return withTransaction(async (tx) => {
    await loadOwnedConcert(tx, organiserId, concertId, 'edit');
    const existing = await repo.listTicketTypes(tx, concertId);
    const newNames = new Set(input.ticketTypes.map((t) => t.name));
    const removed = existing.filter((t) => !newNames.has(t.name));
    const inUse = removed.filter((t) => t.seat_count > 0);
    if (inUse.length > 0) {
      throw new HttpError(
        409,
        'ticket_type_in_use',
        'Cannot remove ticket types that seats still use; replace the layout first',
        { ticketTypes: inUse.map((t) => ({ name: t.name, seatCount: t.seat_count })) },
      );
    }
    if (removed.length > 0) {
      await repo.deleteTicketTypes(
        tx,
        removed.map((t) => t.id),
      );
    }
    await repo.upsertTicketTypes(tx, concertId, input.ticketTypes);
    return { ticketTypes: (await repo.listTicketTypes(tx, concertId)).map(toTicketTypeDto) };
  });
}

interface ExpandedRow {
  sectionName: string;
  label: string;
  sortOrder: number;
  ticketTypeName: string;
  seatNumbers: string[];
}

/**
 * Validates the layout against the concert's ticket types without touching the DB.
 * Rule: every ticket type's seat count must EQUAL its quantity (so inventory and seat map never disagree).
 */
function expandLayout(input: ReplaceLayoutInput, ticketTypes: TicketTypeRow[]) {
  const problems: string[] = [];
  const knownTypes = new Set(ticketTypes.map((t) => t.name));
  const seatsByType = new Map<string, number>();
  const sectionNames = new Set<string>();
  const rows: ExpandedRow[] = [];
  let totalSeats = 0;

  for (const section of input.sections) {
    if (sectionNames.has(section.name)) problems.push(`duplicate section '${section.name}'`);
    sectionNames.add(section.name);
    const rowLabels = new Set<string>();

    section.rows.forEach((row, rowIndex) => {
      const where = `section '${section.name}' row '${row.label}'`;
      if (rowLabels.has(row.label)) problems.push(`duplicate row label in ${where}`);
      rowLabels.add(row.label);
      if (!knownTypes.has(row.ticketTypeName)) problems.push(`${where}: unknown ticket type '${row.ticketTypeName}'`);

      const seatNumbers = row.seats
        ? Array.from({ length: row.seats.to - row.seats.from + 1 }, (_, i) => String(row.seats!.from + i))
        : row.seatNumbers!;
      if (new Set(seatNumbers).size !== seatNumbers.length) problems.push(`${where}: duplicate seat numbers`);

      seatsByType.set(row.ticketTypeName, (seatsByType.get(row.ticketTypeName) ?? 0) + seatNumbers.length);
      totalSeats += seatNumbers.length;
      rows.push({ sectionName: section.name, label: row.label, sortOrder: rowIndex, ticketTypeName: row.ticketTypeName, seatNumbers });
    });
  }

  if (ticketTypes.length === 0) problems.push('define ticket types before the layout');
  if (totalSeats > MAX_SEATS_PER_LAYOUT) problems.push(`layout has ${totalSeats} seats; maximum is ${MAX_SEATS_PER_LAYOUT}`);
  const mismatches = quantityMismatches(ticketTypes, seatsByType);
  if (problems.length > 0 || mismatches.length > 0) {
    throw new HttpError(400, 'invalid_layout', 'Layout does not match the concert ticket types', {
      problems,
      quantityMismatches: mismatches,
    });
  }
  return { rows, totalSeats, seatsByType };
}

/**
 * Replaces the whole seat layout (sections, rows, seats) in ONE transaction: existing layout is deleted and
 * the new one bulk-inserted with three INSERT ... SELECT FROM unnest(...) statements.
 */
export async function replaceLayout(organiserId: string, concertId: string, input: ReplaceLayoutInput) {
  return withTransaction(async (tx) => {
    await loadOwnedConcert(tx, organiserId, concertId, 'edit');
    const ticketTypes = await repo.listTicketTypes(tx, concertId);
    const { rows, totalSeats, seatsByType } = expandLayout(input, ticketTypes);

    // Holds/sales cannot exist before the sale opens, but never silently drop a fan's seat.
    if ((await repo.countUnavailableSeats(tx, concertId)) > 0) {
      throw new HttpError(409, 'seats_in_use', 'Some seats are held or sold; the layout cannot be replaced');
    }
    await repo.deleteLayout(tx, concertId);

    const sections = await repo.insertSections(
      tx,
      concertId,
      input.sections.map((s) => s.name),
    );
    const sectionIdByName = new Map(sections.map((s) => [s.name, s.id]));
    const insertedRows = await repo.insertRows(
      tx,
      rows.map((r) => ({ sectionId: sectionIdByName.get(r.sectionName)!, label: r.label, sortOrder: r.sortOrder })),
    );
    const rowIdByKey = new Map(insertedRows.map((r) => [`${r.section_id}\u0000${r.label}`, r.id]));
    const ticketTypeIdByName = new Map(ticketTypes.map((t) => [t.name, t.id]));

    const seats = rows.flatMap((r) => {
      const sectionId = sectionIdByName.get(r.sectionName)!;
      const rowId = rowIdByKey.get(`${sectionId}\u0000${r.label}`)!;
      const ticketTypeId = ticketTypeIdByName.get(r.ticketTypeName)!;
      return r.seatNumbers.map((seatNumber) => ({ sectionId, rowId, ticketTypeId, seatNumber }));
    });
    const inserted = await repo.insertSeats(tx, concertId, seats);

    return {
      sections: sections.length,
      rows: insertedRows.length,
      seats: inserted,
      seatsByTicketType: Object.fromEntries(seatsByType),
      expectedSeats: totalSeats,
    };
  });
}

/** draft -> scheduled. Requires ticket types and a layout whose seat counts match every quantity. */
export async function publishConcert(organiserId: string, concertId: string) {
  return withTransaction(async (tx) => {
    const concert = await loadOwnedConcert(tx, organiserId, concertId, 'edit');
    if (concert.status !== 'draft') {
      throw new HttpError(409, 'invalid_status', `Only draft concerts can be published (status is ${concert.status})`);
    }
    const ticketTypes = await repo.listTicketTypes(tx, concertId);
    const mismatches = quantityMismatches(ticketTypes, new Map(ticketTypes.map((t) => [t.name, t.seat_count])));
    if (ticketTypes.length === 0 || mismatches.length > 0) {
      throw new HttpError(409, 'not_ready', 'Concert needs ticket types and a seat layout matching their quantities', {
        ticketTypes: ticketTypes.length,
        quantityMismatches: mismatches,
      });
    }
    return toConcertDto(await repo.publishConcert(tx, concertId));
  });
}

/**
 * Allowed in any state except completed, including after the layout locks. After the cancellation commits, every
 * confirmed order's fan is notified: one ConcertCancelled event per order to SNS `order-events`, which ticket-fn
 * turns into an email. Seats (including active holds) are left as-is; checkout refuses holds and confirms on
 * cancelled concerts.
 *
 * Cancelling an already cancelled concert changes nothing in the database and publishes the notices again, with the
 * original reason and time. That is the retry for notices SNS didn't accept: ticket-fn skips fans it already emailed.
 */
export async function cancelConcert(organiserId: string, concertId: string, reason: string) {
  const { concert, orders } = await withTransaction(async (tx) => {
    const current = await loadOwnedConcert(tx, organiserId, concertId, 'lock');
    if (current.status === 'completed') {
      throw new HttpError(409, 'invalid_status', 'Concert is already completed');
    }
    // Listed in the same transaction, so a confirm that commits first is included and one after it is refused.
    const cancelled = current.status === 'cancelled' ? current : await repo.cancelConcert(tx, concertId, reason);
    return { concert: cancelled, orders: await repo.listConfirmedOrders(tx, concertId) };
  });

  const occurredAt = (concert.cancelled_at ?? new Date()).toISOString();
  const noticeReason = concert.cancellation_reason ?? reason;
  const events: ConcertCancelledEvent[] = orders.map((o) => ({
    type: 'ConcertCancelled',
    version: 1,
    occurredAt,
    orderId: o.id,
    fanId: o.fan_id,
    concert: {
      id: concert.id,
      title: concert.title,
      artist: concert.artist,
      venueName: concert.venue_name,
      startsAt: concert.starts_at.toISOString(),
    },
    reason: noticeReason,
    currency: o.currency,
    totalCents: o.total_cents,
  }));
  const { failedOrderIds } = await organiserEvents.publishConcertCancelled(events);
  return {
    ...toConcertDto(concert),
    cancellationNotices: { orders: events.length, published: events.length - failedOrderIds.length },
  };
}

export async function getDashboard(organiserId: string, concertId: string) {
  const concert = await loadOwnedConcert(pool, organiserId, concertId, 'read');
  const rows = await repo.dashboardCounts(pool, concertId);
  const ticketTypes = rows.map((r) => ({
    ticketTypeId: r.ticket_type_id,
    name: r.name,
    priceCents: r.price_cents,
    currency: r.currency,
    quantity: r.quantity,
    available: r.available,
    held: r.held_active,
    heldExpired: r.held_expired,
    sold: r.sold,
    total: r.total,
    // Face value of sold seats; switch to order totals once UC4's orders table exists.
    revenueCents: r.sold * r.price_cents,
  }));
  // Totals assume one currency per concert (every ticket type defaults to SGD).
  const sum = (key: 'available' | 'held' | 'sold' | 'total' | 'revenueCents') =>
    ticketTypes.reduce((n, t) => n + t[key], 0);
  return {
    concertId,
    status: concert.status,
    generatedAt: new Date().toISOString(),
    ticketTypes,
    totals: {
      available: sum('available'),
      held: sum('held'),
      sold: sum('sold'),
      total: sum('total'),
      revenueCents: sum('revenueCents'),
    },
  };
}

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
 */
export async function getSalesReport(organiserId: string, query: SalesReportQuery) {
  const concertId = query.concertId ?? null;
  if (concertId) await loadOwnedConcert(pool, organiserId, concertId, 'read');
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
