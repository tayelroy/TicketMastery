/**
 * Canonical seat-inventory statements (contract documented in
 * migrations/0001_uc5_concerts_ticket_types_seats.sql). Shared by UC4 checkout (Shi Hui) and tests.
 * Every function expects to run inside a transaction opened by the caller (see withTransaction).
 */
import type { Queryable } from './pool';

export const HOLD_MINUTES = 10;

/** Thrown when an all-or-nothing hold/confirm affected fewer seats than requested; caller must ROLLBACK. */
export class SeatsUnavailableError extends Error {
  constructor(
    readonly requested: number,
    readonly affected: number,
  ) {
    super(`only ${affected} of ${requested} seats could be updated`);
    this.name = 'SeatsUnavailableError';
  }
}

/**
 * Holds every seat in `seatIds` for `fanId` under `holdId`, or throws SeatsUnavailableError so the
 * surrounding transaction rolls back and holds nothing. Expired holds are reclaimed in the same statement.
 */
export async function holdSeats(
  tx: Queryable,
  args: { concertId: string; seatIds: string[]; fanId: string; holdId: string },
): Promise<string[]> {
  // Sorted ids => consistent lock order between overlapping holds (fewer deadlocks).
  const seatIds = [...new Set(args.seatIds)].sort();
  const result = await tx.query<{ id: string }>(
    `UPDATE seats
        SET status = 'held', held_by = $3, hold_id = $4,
            held_at = now(), hold_expires_at = now() + make_interval(mins => $5)
      WHERE concert_id = $1
        AND id = ANY($2::uuid[])
        AND (status = 'available' OR (status = 'held' AND hold_expires_at < now()))
      RETURNING id`,
    [args.concertId, seatIds, args.fanId, args.holdId, HOLD_MINUTES],
  );
  if (result.rowCount !== seatIds.length) {
    throw new SeatsUnavailableError(seatIds.length, result.rowCount ?? 0);
  }
  return result.rows.map((r) => r.id);
}

/** Marks the fan's unexpired hold as sold. Throws SeatsUnavailableError if any seat of the hold is gone. */
export async function confirmHold(
  tx: Queryable,
  args: { holdId: string; fanId: string; orderId: string; expectedSeats: number },
): Promise<string[]> {
  const result = await tx.query<{ id: string }>(
    `UPDATE seats
        SET status = 'sold', sold_at = now(), order_id = $3
      WHERE hold_id = $1 AND held_by = $2 AND status = 'held' AND hold_expires_at > now()
      RETURNING id`,
    [args.holdId, args.fanId, args.orderId],
  );
  if (result.rowCount !== args.expectedSeats) {
    throw new SeatsUnavailableError(args.expectedSeats, result.rowCount ?? 0);
  }
  return result.rows.map((r) => r.id);
}

/** Releases the fan's hold (abandoned checkout / failed payment). Returns the number of seats released. */
export async function releaseHold(tx: Queryable, args: { holdId: string; fanId: string }): Promise<number> {
  const result = await tx.query(
    `UPDATE seats
        SET status = 'available', held_by = NULL, hold_id = NULL, held_at = NULL, hold_expires_at = NULL
      WHERE hold_id = $1 AND held_by = $2 AND status = 'held'`,
    [args.holdId, args.fanId],
  );
  return result.rowCount ?? 0;
}

/** Resets up to `batchSize` expired holds to available, skipping rows a checkout currently has locked. */
export async function sweepExpiredHolds(tx: Queryable, batchSize = 1000): Promise<number> {
  const result = await tx.query(
    `UPDATE seats
        SET status = 'available', held_by = NULL, hold_id = NULL, held_at = NULL, hold_expires_at = NULL
      WHERE id IN (SELECT id FROM seats
                    WHERE status = 'held' AND hold_expires_at < now()
                    ORDER BY hold_expires_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED)
        AND status = 'held' AND hold_expires_at < now()`,
    [batchSize],
  );
  return result.rowCount ?? 0;
}
