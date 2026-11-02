// zod/mini rather than zod: same validation, but tree-shakes to a few KB instead of ~450 KB in the bundle.
import * as z from 'zod/mini';

const text = z.string();
const nonEmpty = z.string().check(z.minLength(1));

// Part of S3 keys, so nothing that could escape tickets/ is accepted.
const orderId = z.string().check(z.regex(/^[A-Za-z0-9-]{1,64}$/));

const concert = z.object({
  id: text,
  title: text,
  artist: text,
  venueName: text,
  startsAt: nonEmpty,
});

/**
 * Mirrors OrderConfirmedEvent in services/ticketmastery-api/src/modules/checkout/events.ts (the publisher). The
 * Lambda is packaged on its own, so it can't import the API's source; keep the two in step and bump `version` on a
 * breaking change. Unknown extra fields are allowed so the API can add some without breaking this consumer.
 */
const orderConfirmedEvent = z.object({
  type: z.literal('OrderConfirmed'),
  version: z.literal(1),
  occurredAt: nonEmpty,
  orderId,
  holdId: text,
  fanId: nonEmpty,
  concert,
  currency: nonEmpty,
  seats: z
    .array(
      z.object({
        seatId: text,
        section: text,
        row: text,
        seatNumber: text,
        ticketType: text,
        priceCents: z.int(),
      }),
    )
    .check(z.minLength(1)),
  subtotalCents: z.int(),
  bookingFeeCents: z.int(),
  totalCents: z.int(),
});

export type OrderConfirmedEvent = z.infer<typeof orderConfirmedEvent>;

/**
 * Mirrors ConcertCancelledEvent in services/ticketmastery-api/src/modules/organiser/events.ts: one message per
 * confirmed order of a cancelled concert (contract by Shi Hui, PR #20), so each fan's email retries on its own.
 */
const concertCancelledEvent = z.object({
  type: z.literal('ConcertCancelled'),
  version: z.literal(1),
  occurredAt: nonEmpty,
  orderId,
  fanId: nonEmpty,
  concert,
  reason: text,
  currency: nonEmpty,
  totalCents: z.int(),
});

export type ConcertCancelledEvent = z.infer<typeof concertCancelledEvent>;

/** A message that will never succeed. It still goes back to SQS, so it reaches the DLQ (and its alarm) for a human. */
export class InvalidEventError extends Error {}

function parse<T>(body: string, schema: z.ZodMiniType<T>, name: string): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidEventError('message body is not JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new InvalidEventError(`not a valid ${name} v1 event: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const parseOrderConfirmed = (body: string) => parse(body, orderConfirmedEvent, 'OrderConfirmed');
export const parseConcertCancelled = (body: string) => parse(body, concertCancelledEvent, 'ConcertCancelled');
