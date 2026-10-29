import { z } from 'zod';

export const concertIdParams = z.object({ concertId: z.uuid() });

/**
 * Response of POST /join and GET /status.
 * - pending: join sent to SQS, queue-manager hasn't written the fan's row yet (async, usually < 1s)
 * - waiting: has a queue number, not admitted yet
 * - admitted: may check out until admittedUntil
 * - expired: admission window passed; joining again gives a new number
 */
export interface QueueStatus {
  concertId: string;
  state: 'pending' | 'waiting' | 'admitted' | 'expired';
  position: number | null;
  peopleAhead: number | null;
  admittedUntil: string | null;
}
