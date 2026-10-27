import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });
const optionalSearch = z.string().trim().min(1).max(100).optional();

export const concertIdParams = z.object({ id: z.uuid() });

/** Query string for GET /api/concerts. Text filters are case-insensitive "contains" matches. */
export const listConcertsQuery = z
  .object({
    /** Matches title, artist or venue. */
    q: optionalSearch,
    artist: optionalSearch,
    venue: optionalSearch,
    /** Show start window; `from` defaults to now so past shows drop off the listing. */
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  // Not .strict(): unknown params (cache busters, tracking tags) are ignored rather than rejected.
  .refine((q) => q.from === undefined || q.to === undefined || Date.parse(q.to) >= Date.parse(q.from), {
    path: ['to'],
    message: 'must not be before from',
  });
export type ListConcertsQuery = z.infer<typeof listConcertsQuery>;
