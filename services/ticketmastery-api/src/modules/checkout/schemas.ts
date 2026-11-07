import { z } from 'zod';
import { MAX_SEATS_PER_ORDER } from '../seat-limits';

/** 1-3 seats per hold (one hold = one order); ticket_types.max_per_order (also at most 3) can lower it per type. */
export const createHoldBody = z
  .object({
    concertId: z.uuid(),
    seatIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_SEATS_PER_ORDER)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'seat ids must be unique' }),
  })
  .strict();
export type CreateHoldInput = z.infer<typeof createHoldBody>;

export const holdIdParams = z.object({ holdId: z.uuid() });
export const concertIdParams = z.object({ concertId: z.uuid() });

/** Payment is simulated. `simulatePaymentFailure` lets the demo show the failed-payment path. */
export const confirmHoldBody = z
  .object({
    simulatePaymentFailure: z.boolean().default(false),
  })
  .strict();
export type ConfirmHoldInput = z.infer<typeof confirmHoldBody>;
