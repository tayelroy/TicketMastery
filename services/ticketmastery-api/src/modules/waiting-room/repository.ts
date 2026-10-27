import type { Queryable } from '../../db/pool';

export interface JoinableConcertRow {
  id: string;
  status: string;
  /** Published (scheduled/on_sale) and the sale hasn't ended. Fans may queue before the sale opens. */
  joinable: boolean;
}

export async function findConcertForQueue(db: Queryable, concertId: string) {
  const { rows } = await db.query<JoinableConcertRow>(
    `SELECT id, status,
            (status IN ('scheduled', 'on_sale') AND now() < sale_ends_at) AS joinable
       FROM concerts
      WHERE id = $1`,
    [concertId],
  );
  return rows[0];
}
