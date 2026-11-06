import { z } from 'zod';

/** GET /sales?days=7|30|90|all&concertId=<uuid>. `all` = since the first sale. */
export const salesReportQuery = z.object({
  days: z.enum(['7', '30', '90', 'all']).default('30'),
  concertId: z.uuid().optional(),
});
export type SalesReportQuery = z.infer<typeof salesReportQuery>;
