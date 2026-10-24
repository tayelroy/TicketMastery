import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../../db/pool';
import { HOLD_MINUTES, holdSeats, SeatsUnavailableError } from '../../db/seat-holds';
import { HttpError } from '../../http/errors';
import { isAdmitted } from './admission';
import * as repo from './repository';
import type { OrderRow, SeatForHoldRow } from './repository';
import type { CreateHoldInput } from './schemas';

/** Flat booking fee per seat (the proposal mockup: 2 seats -> $8.00). */
export const BOOKING_FEE_CENTS_PER_SEAT = 400;

/**
 * Concert statuses that can sell, provided the sale window is open. Nothing moves a concert to 'on_sale'
 * yet (UC5 publishes to 'scheduled'), so a published concert inside its window counts as on sale.
 */
const SELLABLE_STATUSES = new Set(['scheduled', 'on_sale']);

function toHoldDto(order: OrderRow, seats: SeatForHoldRow[]) {
  return {
    holdId: order.hold_id,
    orderId: order.id,
    concertId: order.concert_id,
    status: order.status,
    expiresAt: order.expires_at,
    currency: order.currency,
    seats: seats.map((s) => ({
      seatId: s.id,
      section: s.section_name,
      row: s.row_label,
      seatNumber: s.seat_number,
      ticketTypeId: s.ticket_type_id,
      ticketType: s.ticket_type_name,
      priceCents: s.price_cents,
    })),
    subtotalCents: order.subtotal_cents,
    bookingFeeCents: order.booking_fee_cents,
    totalCents: order.total_cents,
  };
}

/** Ticket types where this request asks for more seats than max_per_order allows. */
function overLimit(seats: SeatForHoldRow[]) {
  const byType = new Map<string, { name: string; max: number; requested: number }>();
  for (const s of seats) {
    const entry = byType.get(s.ticket_type_id) ?? { name: s.ticket_type_name, max: s.max_per_order, requested: 0 };
    entry.requested += 1;
    byType.set(s.ticket_type_id, entry);
  }
  return [...byType.values()]
    .filter((t) => t.requested > t.max)
    .map((t) => ({ ticketType: t.name, maxPerOrder: t.max, requested: t.requested }));
}

/**
 * Holds the requested seats for HOLD_MINUTES and creates a pending order priced at today's prices, all in one
 * transaction: either every seat is held and the order exists, or nothing changes.
 */
export async function createHold(fanId: string, input: CreateHoldInput) {
  if (!(await isAdmitted(fanId, input.concertId))) {
    throw new HttpError(403, 'not_admitted', 'You have not been admitted from the waiting room yet');
  }

  try {
    return await withTransaction(async (tx) => {
      await repo.lockFanConcert(tx, fanId, input.concertId);

      const concert = await repo.findConcertForCheckout(tx, input.concertId);
      if (!concert) {
        throw new HttpError(404, 'not_found', 'Concert not found');
      }
      if (!SELLABLE_STATUSES.has(concert.status) || !concert.sale_open) {
        throw new HttpError(409, 'not_on_sale', 'Tickets for this concert are not on sale right now', {
          status: concert.status,
          saleStartsAt: concert.sale_starts_at,
          saleEndsAt: concert.sale_ends_at,
        });
      }

      const existing = await repo.findActivePendingOrder(tx, fanId, input.concertId);
      if (existing) {
        throw new HttpError(409, 'active_hold_exists', 'You already have seats on hold for this concert', {
          holdId: existing.hold_id,
          expiresAt: existing.expires_at,
        });
      }

      const seats = await repo.findSeatsForHold(tx, input.concertId, input.seatIds);
      if (seats.length !== input.seatIds.length) {
        const found = new Set(seats.map((s) => s.id));
        throw new HttpError(400, 'unknown_seats', 'Some seats do not belong to this concert', {
          seatIds: input.seatIds.filter((id) => !found.has(id)),
        });
      }
      const limits = overLimit(seats);
      if (limits.length > 0) {
        throw new HttpError(400, 'too_many_seats', 'Too many seats of one ticket type in a single order', {
          ticketTypes: limits,
        });
      }
      const currencies = new Set(seats.map((s) => s.currency));
      if (currencies.size !== 1) {
        throw new HttpError(400, 'mixed_currency', 'Seats priced in different currencies cannot share an order');
      }

      const holdId = randomUUID();
      await holdSeats(tx, { concertId: input.concertId, seatIds: input.seatIds, fanId, holdId });

      const order = await repo.insertPendingOrder(tx, {
        fanId,
        concertId: input.concertId,
        holdId,
        currency: seats[0]!.currency,
        subtotalCents: seats.reduce((sum, s) => sum + s.price_cents, 0),
        bookingFeeCents: seats.length * BOOKING_FEE_CENTS_PER_SEAT,
        holdMinutes: HOLD_MINUTES,
      });
      await repo.insertOrderItems(
        tx,
        order.id,
        seats.map((s) => ({ seatId: s.id, ticketTypeId: s.ticket_type_id, priceCents: s.price_cents })),
      );
      return toHoldDto(order, seats);
    });
  } catch (err) {
    if (err instanceof SeatsUnavailableError) {
      // The transaction has rolled back, so nothing is held. Tell the fan which seats to pick again.
      throw new HttpError(409, 'seats_unavailable', 'Some of the selected seats were just taken', {
        seatIds: await repo.findUnavailableSeatIds(pool, input.concertId, input.seatIds),
      });
    }
    throw err;
  }
}
