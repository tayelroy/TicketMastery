// zod/mini rather than zod: same validation, but tree-shakes to a few KB instead of ~450 KB in the bundle.
import * as z from 'zod/mini';

const text = z.string();
const nonEmpty = z.string().check(z.minLength(1));

/**
 * Mirrors OrderConfirmedEvent in services/ticketmastery-api/src/modules/checkout/events.ts (the publisher). The
 * Lambda is packaged on its own, so it can't import the API's source; keep the two in step and bump `version` on a
 * breaking change. Unknown extra fields are allowed so the API can add some without breaking this consumer.
 */
const orderConfirmedEvent = z.object({
  type: z.literal('OrderConfirmed'),
  version: z.literal(1),
  occurredAt: nonEmpty,
  // Part of the S3 key, so nothing that could escape tickets/ is accepted.
  orderId: z.string().check(z.regex(/^[A-Za-z0-9-]{1,64}$/)),
  holdId: text,
  fanId: nonEmpty,
  concert: z.object({
    id: text,
    title: text,
    artist: text,
    venueName: text,
    startsAt: nonEmpty,
  }),
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

/** A message that will never succeed. It still goes back to SQS, so it reaches the DLQ (and its alarm) for a human. */
export class InvalidEventError extends Error {}

export function parseOrderConfirmed(body: string): OrderConfirmedEvent {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidEventError('message body is not JSON');
  }
  const result = orderConfirmedEvent.safeParse(json);
  if (!result.success) {
    throw new InvalidEventError(`not a valid OrderConfirmed v1 event: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
