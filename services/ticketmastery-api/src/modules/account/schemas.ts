import { z } from 'zod';

/** One e-ticket per order (ticket-fn renders one PDF per OrderConfirmed), so a ticket id is the order id. */
export const ticketIdParams = z.object({ ticketId: z.uuid() });
