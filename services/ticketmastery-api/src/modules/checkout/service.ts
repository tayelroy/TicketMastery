import { randomUUID } from 'node:crypto';
import { pool, type Queryable, withTransaction } from '../../db/pool';
import {
  confirmHold as confirmSeats,
  HOLD_MINUTES,
  holdSeats,
  releaseHold as releaseSeats,
  SeatsUnavailableError,
} from '../../db/seat-holds';
import { HttpError } from '../../http/errors';
import { isAdmitted } from './admission';
import { type OrderConfirmedEvent, orderEvents } from './events';
import * as repo from './repository';
import type { ConcertStatus, ConcertSummaryRow, OrderRow, OrderSeatRow, SeatForHoldRow } from './repository';
import type { ConfirmHoldInput, CreateHoldInput } from './schemas';

/**
 * Flat booking fee per seat (the proposal mockup: 2 seats -> $8.00), in the order's minor units. Every ticket
 * type is SGD today; a concert priced in another currency would need its own fee.
 */
export const BOOKING_FEE_CENTS_PER_SEAT = 400;

/**
 * Concert statuses that can sell, provided the sale window is open. Nothing moves a concert to 'on_sale'
 * yet (UC5 publishes to 'scheduled'), so a published concert inside its window counts as on sale.
 */
/**
 * A repeat confirm re-publishes OrderConfirmed only once the order has been confirmed this long without SNS
 * accepting it. Shorter, and a double-click would publish again while the first request is still publishing.
 */
export const REPUBLISH_AFTER_SECONDS = 60;

const SELLABLE_STATUSES: ReadonlySet<ConcertStatus> = new Set<ConcertStatus>(['scheduled', 'on_sale']);

function toHoldDto(order: OrderRow, seats: OrderSeatRow[]) {
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

      // A fan who walked away from an earlier hold: close that order and free whatever it still holds.
      for (const staleHoldId of await repo.expireStalePendingOrders(tx, fanId, input.concertId)) {
        await releaseSeats(tx, { holdId: staleHoldId, fanId });
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

function toOrderConfirmedEvent(
  order: OrderRow,
  seats: OrderSeatRow[],
  concert: ConcertSummaryRow,
): OrderConfirmedEvent {
  return {
    type: 'OrderConfirmed',
    version: 1,
    occurredAt: (order.confirmed_at ?? new Date()).toISOString(),
    orderId: order.id,
    holdId: order.hold_id,
    fanId: order.fan_id,
    concert: {
      id: concert.id,
      title: concert.title,
      artist: concert.artist,
      venueName: concert.venue_name,
      startsAt: concert.starts_at.toISOString(),
    },
    currency: order.currency,
    seats: seats.map((s) => ({
      seatId: s.id,
      section: s.section_name,
      row: s.row_label,
      seatNumber: s.seat_number,
      ticketType: s.ticket_type_name,
      priceCents: s.price_cents,
    })),
    subtotalCents: order.subtotal_cents,
    bookingFeeCents: order.booking_fee_cents,
    totalCents: order.total_cents,
  };
}

/**
 * Lets the fan give the seats back. The order becomes 'cancelled' (or 'expired' if the 10 minutes were already
 * up). Releasing an order that is already cancelled/expired returns it unchanged, so a retry is harmless.
 */
export async function releaseHold(fanId: string, holdId: string) {
  return withTransaction(async (tx) => {
    const order = await repo.lockOrderByHold(tx, fanId, holdId, REPUBLISH_AFTER_SECONDS);
    if (!order) {
      throw new HttpError(404, 'not_found', 'Hold not found');
    }
    if (order.status === 'confirmed') {
      throw new HttpError(409, 'order_confirmed', 'This order has been paid for; its seats can no longer be released');
    }
    if (order.status === 'pending') {
      // Only touches seats still held under this hold id; seats another fan has since reclaimed are left alone.
      await releaseSeats(tx, { holdId, fanId });
      const updated = await repo.setOrderStatus(tx, order.id, order.hold_expired ? 'expired' : 'cancelled');
      return toHoldDto(updated, await repo.findOrderSeats(tx, order.id));
    }
    return toHoldDto(order, await repo.findOrderSeats(tx, order.id));
  });
}

const holdExpiredError = () =>
  new HttpError(409, 'hold_expired', 'Your 10-minute hold has run out; please pick your seats again');

/** Builds OrderConfirmed from the database (used for the first publish and for re-publishing). */
async function buildOrderConfirmedEvent(tx: Queryable, order: OrderRow, seats: OrderSeatRow[]) {
  return toOrderConfirmedEvent(order, seats, await repo.findConcertSummary(tx, order.concert_id));
}

/**
 * Simulated payment. On success the seats are sold and the order confirmed in one transaction, then
 * OrderConfirmed is published to SNS (the e-ticket pipeline); checkout never waits for the email.
 * On failure, or when the hold has run out or the concert was cancelled, the seats are released and the
 * order closed, then the fan gets an error.
 *
 * Confirming an already confirmed order returns it again (double-click safe). If its OrderConfirmed never
 * reached SNS (publish failed, or the task died right after COMMIT) and REPUBLISH_AFTER_SECONDS have passed,
 * it is published again, so a paid order can always get its e-ticket. published_at records the first
 * successful publish.
 */
export async function confirmHold(fanId: string, holdId: string, input: ConfirmHoldInput) {
  let outcome:
    | { kind: 'confirmed'; dto: ReturnType<typeof toHoldDto>; event?: OrderConfirmedEvent }
    | { kind: 'refused'; error: HttpError };

  try {
    outcome = await withTransaction(async (tx) => {
      const order = await repo.lockOrderByHold(tx, fanId, holdId, REPUBLISH_AFTER_SECONDS);
      if (!order) {
        throw new HttpError(404, 'not_found', 'Hold not found');
      }
      if (order.status === 'confirmed') {
        const seats = await repo.findOrderSeats(tx, order.id);
        return {
          kind: 'confirmed' as const,
          dto: toHoldDto(order, seats),
          event: order.republish_due ? await buildOrderConfirmedEvent(tx, order, seats) : undefined,
        };
      }
      if (order.status === 'cancelled') {
        throw new HttpError(409, 'hold_cancelled', 'This hold has been cancelled; please pick your seats again');
      }
      if (order.status === 'expired') {
        throw holdExpiredError();
      }

      // Every refusal below closes the order and frees its seats; the transaction then commits that change
      // and the error is thrown after the commit.
      const close = async (status: 'cancelled' | 'expired', error: HttpError) => {
        await releaseSeats(tx, { holdId, fanId });
        await repo.setOrderStatus(tx, order.id, status);
        return { kind: 'refused' as const, error };
      };

      if (order.hold_expired) {
        return close('expired', holdExpiredError());
      }
      const concert = await repo.findConcertForCheckout(tx, order.concert_id);
      if (concert?.status === 'cancelled') {
        return close('cancelled', new HttpError(409, 'concert_cancelled', 'This concert has been cancelled'));
      }
      if (input.simulatePaymentFailure) {
        return close(
          'cancelled',
          new HttpError(402, 'payment_failed', 'Payment was declined; your seats have been released'),
        );
      }

      const seats = await repo.findOrderSeats(tx, order.id);
      await confirmSeats(tx, { holdId, fanId, orderId: order.id, expectedSeats: seats.length });
      const confirmed = await repo.setOrderStatus(tx, order.id, 'confirmed');
      return {
        kind: 'confirmed' as const,
        dto: toHoldDto(confirmed, seats),
        event: await buildOrderConfirmedEvent(tx, confirmed, seats),
      };
    });
  } catch (err) {
    if (err instanceof SeatsUnavailableError) {
      // The hold ran out between the check and the update (another fan reclaimed a seat). Nothing was sold.
      throw holdExpiredError();
    }
    throw err;
  }

  if (outcome.kind === 'refused') {
    throw outcome.error;
  }
  if (outcome.event && (await orderEvents.publishOrderConfirmed(outcome.event))) {
    await repo.markPublished(pool, outcome.event.orderId);
  }
  return outcome.dto;
}
