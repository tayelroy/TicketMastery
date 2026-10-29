import type { QueueCounter, QueueEntry } from './queue';
import type { QueueStatus } from './schemas';

/** Maps the fan's live-queue row (and the concert's counter row) to the API response. */
export function toQueueStatus(
  concertId: string,
  entry: QueueEntry | undefined,
  counter: QueueCounter,
  now = Date.now(),
): QueueStatus {
  const base = { concertId, position: null, peopleAhead: null, admittedUntil: null };
  if (!entry) return { ...base, state: 'pending' };

  if (entry.status === 'ADMITTED') {
    const until = entry.admissionExpiresAt !== undefined ? entry.admissionExpiresAt * 1000 : undefined;
    return {
      ...base,
      state: until !== undefined && now > until ? 'expired' : 'admitted',
      position: entry.position,
      peopleAhead: 0,
      admittedUntil: until !== undefined ? new Date(until).toISOString() : null,
    };
  }
  if (entry.status === 'EXPIRED') return { ...base, state: 'expired', position: entry.position };

  return {
    ...base,
    state: 'waiting',
    position: entry.position,
    peopleAhead: Math.max(0, entry.position - 1 - counter.admittedUpTo),
  };
}
