import { z } from 'zod';

/** Upper bounds keep a single layout transaction (and request body) a sane size. */
export const MAX_SEATS_PER_LAYOUT = 50_000;
const MAX_SEATS_PER_ROW = 500;

const isoDateTime = z.iso.datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const concertIdParams = z.object({ id: z.uuid() });

export const createConcertBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().min(1).max(200),
    description: optionalText(5000),
    venueName: z.string().trim().min(1).max(200),
    venueAddress: optionalText(500),
    startsAt: isoDateTime,
    endsAt: isoDateTime.optional(),
    saleStartsAt: isoDateTime,
    saleEndsAt: isoDateTime,
    imageUrl: z.url({ protocol: /^https?$/ }).max(2000).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Mirrors the concerts CHECK constraints so callers get field-level errors instead of a 400 from Postgres.
    const startsAt = Date.parse(c.startsAt);
    const saleStartsAt = Date.parse(c.saleStartsAt);
    const saleEndsAt = Date.parse(c.saleEndsAt);
    if (saleStartsAt <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['saleStartsAt'], message: 'must be in the future' });
    }
    if (saleEndsAt <= saleStartsAt) {
      ctx.addIssue({ code: 'custom', path: ['saleEndsAt'], message: 'must be after saleStartsAt' });
    }
    if (saleEndsAt > startsAt) {
      ctx.addIssue({ code: 'custom', path: ['saleEndsAt'], message: 'must not be after startsAt' });
    }
    if (c.endsAt !== undefined && Date.parse(c.endsAt) <= startsAt) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'must be after startsAt' });
    }
  });
export type CreateConcertInput = z.infer<typeof createConcertBody>;

export const replaceTicketTypesBody = z
  .object({
    ticketTypes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(50),
            description: optionalText(1000),
            priceCents: z.number().int().min(0).max(10_000_000),
            currency: z.string().regex(/^[A-Z]{3}$/).default('SGD'),
            quantity: z.number().int().min(1).max(MAX_SEATS_PER_LAYOUT),
            maxPerOrder: z.number().int().min(1).max(20).default(4),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.ticketTypes.forEach((t, i) => {
      if (seen.has(t.name)) {
        ctx.addIssue({ code: 'custom', path: ['ticketTypes', i, 'name'], message: `duplicate name '${t.name}'` });
      }
      seen.add(t.name);
    });
  });
export type ReplaceTicketTypesInput = z.infer<typeof replaceTicketTypesBody>;

const layoutRow = z
  .object({
    label: z.string().trim().min(1).max(10),
    ticketTypeName: z.string().trim().min(1).max(50),
    /** Inclusive numeric range, e.g. { from: 1, to: 20 } -> seats "1".."20". */
    seats: z
      .object({ from: z.number().int().min(1), to: z.number().int().min(1) })
      .strict()
      .refine((r) => r.to >= r.from, { message: 'to must be >= from' })
      .refine((r) => r.to - r.from + 1 <= MAX_SEATS_PER_ROW, { message: `at most ${MAX_SEATS_PER_ROW} seats per row` })
      .optional(),
    /** Explicit seat labels for irregular rows, e.g. ["1", "2", "2A"]. */
    seatNumbers: z.array(z.string().trim().min(1).max(10)).min(1).max(MAX_SEATS_PER_ROW).optional(),
  })
  .strict()
  .refine((r) => (r.seats === undefined) !== (r.seatNumbers === undefined), {
    message: 'provide exactly one of seats {from, to} or seatNumbers',
  });

export const replaceLayoutBody = z
  .object({
    sections: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(50),
            rows: z.array(layoutRow).min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type ReplaceLayoutInput = z.infer<typeof replaceLayoutBody>;

export const cancelConcertBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
