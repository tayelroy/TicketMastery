import { z } from 'zod';

/** Hard cap per request; the real per-ticket-type limit is ticket_types.max_per_order (at most 20). */
export const MAX_SEATS_PER_HOLD = 20;

export const createHoldBody = z
  .object({
    concertId: z.uuid(),
    seatIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_SEATS_PER_HOLD)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'seat ids must be unique' }),
  })
  .strict();
export type CreateHoldInput = z.infer<typeof createHoldBody>;

export const holdIdParams = z.object({ holdId: z.uuid() });

/** Payment is simulated. `simulatePaymentFailure` lets the demo show the failed-payment path. */
export const confirmHoldBody = z
  .object({
    simulatePaymentFailure: z.boolean().default(false),
  })
  .strict();
export type ConfirmHoldInput = z.infer<typeof confirmHoldBody>;
