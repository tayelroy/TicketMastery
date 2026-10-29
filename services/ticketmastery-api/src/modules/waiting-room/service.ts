import { pool } from '../../db/pool';
import { HttpError } from '../../http/errors';
import { waitingRoomQueue } from './queue';
import { findConcertForQueue } from './repository';
import type { QueueStatus } from './schemas';
import { toQueueStatus } from './status';

function assertConfigured() {
  if (!waitingRoomQueue.isConfigured()) {
    throw new HttpError(
      501,
      'not_implemented',
      'Waiting room is not configured here (WAITING_ROOM_JOIN_QUEUE_URL / WAITING_ROOM_TABLE_NAME unset)',
    );
  }
}

export async function getStatus(userId: string, concertId: string): Promise<QueueStatus> {
  assertConfigured();
  const [entry, counter] = await Promise.all([
    waitingRoomQueue.getEntry(concertId, userId),
    waitingRoomQueue.getCounter(concertId),
  ]);
  return toQueueStatus(concertId, entry, counter);
}

/**
 * Sends the join to SQS FIFO; queue-manager assigns the number asynchronously. Safe to repeat: a fan who is
 * already queued keeps their number and nothing is sent.
 */
export async function join(userId: string, concertId: string): Promise<QueueStatus> {
  assertConfigured();
  const concert = await findConcertForQueue(pool, concertId);
  if (!concert) throw new HttpError(404, 'not_found', 'Concert not found');
  if (!concert.joinable) {
    throw new HttpError(409, 'not_joinable', `This concert has no ticket sale to queue for (status is ${concert.status})`);
  }

  const current = await getStatus(userId, concertId);
  if (current.state === 'waiting' || current.state === 'admitted') return current;

  await waitingRoomQueue.sendJoin(concertId, userId);
  return { ...current, state: 'pending', position: null, peopleAhead: null, admittedUntil: null };
}
