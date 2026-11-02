import { waitingRoomQueue } from '../waiting-room/queue';
import { toQueueStatus } from '../waiting-room/status';

/**
 * Waiting-room admission check (UC3 → UC4): the fan's row in DynamoDB `live-queue` (eventId = concertId,
 * userId = fanId) must be `ADMITTED` with `admissionExpiresAt` still ahead. queue-manager's scheduled admit step
 * writes it. Judged by the same mapping as GET /api/waiting-room/:id/status, so the checkout never refuses a fan the
 * waiting room just told "you're in".
 *
 * WAITING_ROOM_TABLE_NAME unset (local dev, tests): the waiting room is off and every fan is admitted.
 */
export async function isAdmitted(fanId: string, concertId: string, now = Date.now()): Promise<boolean> {
  if (!waitingRoomQueue.hasTable()) return true;
  const entry = await waitingRoomQueue.getEntry(concertId, fanId);
  // The counter only feeds peopleAhead, which doesn't matter here.
  return toQueueStatus(concertId, entry, { lastPosition: 0, admittedUpTo: 0 }, now).state === 'admitted';
}
