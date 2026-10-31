// NFR-3 SQL check: no seat in two confirmed orders, and seats.status agrees with the confirmed orders.
// Runs with the API's own `pg` package and DB settings: inside the ECS task through ECS Exec (piped to `node -` from
// /app, see scripts/nfr3-oversell-check.sh) or locally against docker-compose Postgres.
// Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL (the task's own), CONCERT_ID (optional: one concert).
// Prints one line: OVERSELL_CHECK_RESULT {json}
'use strict';
const fs = require('fs');

// ECS Exec sessions normally inherit the container environment; fall back to PID 1's if they don't.
if (!process.env.DB_PASSWORD) {
  try {
    for (const kv of fs.readFileSync('/proc/1/environ', 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0 && kv.startsWith('DB_') && process.env[kv.slice(0, i)] === undefined) process.env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch (e) {
    /* not in a container */
  }
}

const { Client } = require('pg');
const concertId = process.env.CONCERT_ID || null;

const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  statement_timeout: 30000,
});

const one = async (sql) => (await client.query(sql, [concertId])).rows;

(async () => {
  await client.connect();
  // $1 = concert id or NULL for every concert.
  const doubleSold = await one(`
    SELECT oi.seat_id, count(*)::int AS confirmed_orders, array_agg(o.id) AS order_ids
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'confirmed' AND ($1::uuid IS NULL OR o.concert_id = $1)
     GROUP BY oi.seat_id HAVING count(*) > 1`);
  const [counts] = await one(`
    SELECT
      (SELECT count(*)::int FROM orders o WHERE o.status = 'confirmed' AND ($1::uuid IS NULL OR o.concert_id = $1)) AS confirmed_orders,
      (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status = 'confirmed' AND ($1::uuid IS NULL OR o.concert_id = $1)) AS confirmed_order_seats,
      (SELECT count(*)::int FROM seats s WHERE s.status = 'sold' AND ($1::uuid IS NULL OR s.concert_id = $1)) AS sold_seats,
      (SELECT count(*)::int FROM seats s LEFT JOIN orders o ON o.id = s.order_id
        WHERE s.status = 'sold' AND (o.id IS NULL OR o.status <> 'confirmed') AND ($1::uuid IS NULL OR s.concert_id = $1)) AS sold_without_confirmed_order,
      (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN seats s ON s.id = oi.seat_id
        WHERE o.status = 'confirmed' AND (s.status <> 'sold' OR s.order_id IS DISTINCT FROM o.id)
          AND ($1::uuid IS NULL OR o.concert_id = $1)) AS confirmed_seat_not_sold_to_order,
      (SELECT count(*)::int FROM orders o WHERE ($1::uuid IS NULL OR o.concert_id = $1)) AS orders_all_states,
      now() AS checked_at`);
  const result = {
    scope: concertId ? `concert ${concertId}` : 'all concerts',
    db: `${process.env.DB_HOST}/${process.env.DB_NAME}`,
    ...counts,
    seats_in_two_confirmed_orders: doubleSold.length,
    double_sold_examples: doubleSold.slice(0, 10),
  };
  result.pass =
    result.seats_in_two_confirmed_orders === 0 &&
    result.sold_without_confirmed_order === 0 &&
    result.confirmed_seat_not_sold_to_order === 0 &&
    result.sold_seats === result.confirmed_order_seats;
  console.log(`OVERSELL_CHECK_RESULT ${JSON.stringify(result)}`);
  await client.end();
})().catch((e) => {
  console.log(`OVERSELL_CHECK_RESULT ${JSON.stringify({ error: e.message })}`);
  process.exit(1);
});
