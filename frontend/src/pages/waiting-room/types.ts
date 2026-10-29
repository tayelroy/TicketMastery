/** Response shapes for UC3. The waiting-room API is still a stub, so QueueStatus is the planned contract. */

/** The fields this page needs from GET /api/concerts/:id. */
export interface Concert {
  id: string;
  title: string;
  artist: string;
  venueName: string;
  startsAt: string;
  saleStartsAt: string;
}

/**
 * GET /api/waiting-room/:concertId/status
 * - pending: joined, but queue-manager hasn't assigned a number yet (SQS -> Lambda is async)
 * - waiting: has a number, not admitted yet
 * - admitted: may go to checkout until admittedUntil
 * - expired: admission window passed without checking out
 */
export interface QueueStatus {
  state: 'pending' | 'waiting' | 'admitted' | 'expired';
  position: number | null;
  peopleAhead: number | null;
  admittedUntil: string | null;
}
