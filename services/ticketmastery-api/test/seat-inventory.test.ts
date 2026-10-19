/**
 * Integration tests for the layout lock and the canonical all-or-nothing seat hold.
 * Needs a real Postgres: set DB_HOST/DB_NAME/DB_USER/DB_PASSWORD (e.g. the docker compose database) and
 * run `npm test`. Skipped when DB_HOST is unset. Everything runs in a throwaway schema that is dropped at
 * the end, so it is safe against a dev database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as SeatHoldsModule from '../src/db/seat-holds';
import type * as ErrorsModule from '../src/http/errors';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-test';
const layoutLocked = { code: 'P0001', message: /layout locked/ };

describe('seat inventory (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  // Loaded with import() in before(), not statically: config.ts validates the DB env on import (exiting
  // the process when it is missing, which would defeat the skip above), and PGOPTIONS must point the
  // pool at the throwaway schema before pool.ts creates it.
  let db: typeof PoolModule;
  let service: typeof OrganiserServiceModule;
  let holds: typeof SeatHoldsModule;
  let errors: typeof ErrorsModule;

  async function createConcertWithLayout(seatCount: number) {
    const day = 24 * 60 * 60 * 1000;
    const concert = await service.createConcert(ORGANISER, {
      title: `Test ${randomUUID()}`,
      artist: 'Test Artist',
      venueName: 'Test Hall',
      saleStartsAt: new Date(Date.now() + day).toISOString(),
      saleEndsAt: new Date(Date.now() + 2 * day).toISOString(),
      startsAt: new Date(Date.now() + 3 * day).toISOString(),
    });
    await service.replaceTicketTypes(ORGANISER, concert.id, {
      ticketTypes: [{ name: 'GA', priceCents: 10_000, currency: 'SGD', quantity: seatCount, maxPerOrder: 4 }],
    });
    await service.replaceLayout(ORGANISER, concert.id, {
      sections: [{ name: 'Floor', rows: [{ label: 'A', ticketTypeName: 'GA', seats: { from: 1, to: seatCount } }] }],
    });
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM seats WHERE concert_id = $1 ORDER BY seat_number::int',
      [concert.id],
    );
    return { concertId: concert.id, seatIds: rows.map((r) => r.id) };
  }

  /** Simulates the sale opening: from here on the layout lock applies. */
  async function openSale(concertId: string) {
    await db.query(
      `UPDATE concerts SET status = 'on_sale', sale_starts_at = now() - interval '1 minute' WHERE id = $1`,
      [concertId],
    );
  }

  async function seatStates(seatIds: string[]) {
    const { rows } = await db.query<{ id: string; status: string; held_by: string | null }>(
      'SELECT id, status, held_by FROM seats WHERE id = ANY($1::uuid[])',
      [seatIds],
    );
    return Object.fromEntries(rows.map((r) => [r.id, { status: r.status, heldBy: r.held_by }]));
  }

  before(async () => {
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    service = await import('../src/modules/organiser/service.js');
    holds = await import('../src/db/seat-holds.js');
    errors = await import('../src/http/errors.js');
  });

  after(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('layout lock blocks structural changes once the sale opens, but not seat holds', async () => {
    const { concertId, seatIds } = await createConcertWithLayout(4);
    await openSale(concertId);
    const seat = seatIds[0]!;

    await assert.rejects(
      service.replaceLayout(ORGANISER, concertId, {
        sections: [{ name: 'Floor', rows: [{ label: 'A', ticketTypeName: 'GA', seats: { from: 1, to: 4 } }] }],
      }),
      (err) => err instanceof errors.HttpError && err.status === 409 && err.code === 'layout_locked',
    );
    // DB triggers are the backstop for anything bypassing the service.
    await assert.rejects(db.query(`INSERT INTO sections (concert_id, name) VALUES ($1, 'Balcony')`, [concertId]), layoutLocked);
    await assert.rejects(db.query(`UPDATE seats SET seat_number = '99' WHERE id = $1`, [seat]), layoutLocked);
    await assert.rejects(db.query('DELETE FROM seats WHERE id = $1', [seat]), layoutLocked);
    await assert.rejects(db.query('UPDATE ticket_types SET price_cents = 1 WHERE concert_id = $1', [concertId]), layoutLocked);
    await assert.rejects(db.query('DELETE FROM concerts WHERE id = $1', [concertId]), layoutLocked);
    await assert.rejects(
      db.query(`UPDATE concerts SET sale_starts_at = now() + interval '1 day' WHERE id = $1`, [concertId]),
      layoutLocked,
    );

    // Checkout's status/hold columns stay writable.
    await db.withTransaction((tx) =>
      holds.holdSeats(tx, { concertId, seatIds: [seat], fanId: 'fan-1', holdId: randomUUID() }),
    );
    assert.equal((await seatStates([seat]))[seat]!.status, 'held');
  });

  test('two concurrent holds on the same seat: exactly one wins', async () => {
    const { concertId, seatIds } = await createConcertWithLayout(4);
    await openSale(concertId);
    const contested = [seatIds[0]!, seatIds[1]!];

    // Each attempt keeps its transaction open briefly after the UPDATE so the other must block on the row
    // locks and then re-check the WHERE clause against the committed winner.
    const attempt = (fanId: string) =>
      db.withTransaction(async (tx) => {
        const held = await holds.holdSeats(tx, { concertId, seatIds: contested, fanId, holdId: randomUUID() });
        await tx.query('SELECT pg_sleep(0.2)');
        return held;
      });
    const results = await Promise.allSettled([attempt('fan-a'), attempt('fan-b')]);

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]!.reason instanceof holds.SeatsUnavailableError);

    const states = Object.values(await seatStates(contested));
    assert.equal(new Set(states.map((s) => s.heldBy)).size, 1, 'both seats held by the same single winner');
    assert.ok(states.every((s) => s.status === 'held'));
  });

  test('a partially available request holds nothing (all-or-nothing)', async () => {
    const { concertId, seatIds } = await createConcertWithLayout(4);
    await openSale(concertId);
    const [s1, s2, s3] = [seatIds[0]!, seatIds[1]!, seatIds[2]!];
    await db.withTransaction((tx) => holds.holdSeats(tx, { concertId, seatIds: [s1], fanId: 'fan-a', holdId: randomUUID() }));

    await assert.rejects(
      db.withTransaction((tx) => holds.holdSeats(tx, { concertId, seatIds: [s1, s2, s3], fanId: 'fan-b', holdId: randomUUID() })),
      holds.SeatsUnavailableError,
    );
    const states = await seatStates([s1, s2, s3]);
    assert.deepEqual(states[s1], { status: 'held', heldBy: 'fan-a' });
    assert.deepEqual(states[s2], { status: 'available', heldBy: null });
    assert.deepEqual(states[s3], { status: 'available', heldBy: null });
  });

  test('an expired hold is reclaimable immediately and can no longer be confirmed', async () => {
    const { concertId, seatIds } = await createConcertWithLayout(2);
    await openSale(concertId);
    const seat = seatIds[0]!;
    const staleHold = randomUUID();
    await db.withTransaction((tx) => holds.holdSeats(tx, { concertId, seatIds: [seat], fanId: 'fan-a', holdId: staleHold }));
    await db.query(
      `UPDATE seats SET held_at = now() - interval '11 minutes', hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [seat],
    );

    await db.withTransaction((tx) => holds.holdSeats(tx, { concertId, seatIds: [seat], fanId: 'fan-b', holdId: randomUUID() }));
    await assert.rejects(
      db.withTransaction((tx) =>
        holds.confirmHold(tx, { holdId: staleHold, fanId: 'fan-a', orderId: randomUUID(), expectedSeats: 1 }),
      ),
      holds.SeatsUnavailableError,
    );
    assert.deepEqual((await seatStates([seat]))[seat], { status: 'held', heldBy: 'fan-b' });
  });

  test('an unlocked draft concert can be deleted with its whole layout', async () => {
    const { concertId } = await createConcertWithLayout(3);
    await db.query('DELETE FROM concerts WHERE id = $1', [concertId]);
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM seats WHERE concert_id = $1', [concertId]);
    assert.equal(rows[0]!.n, 0);
  });
});
