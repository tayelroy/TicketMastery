/**
 * Integration tests for UC4 checkout holds (POST /api/checkout/holds via the service).
 * Needs a real Postgres, like seat-inventory.test.ts: skipped when DB_HOST is unset, and everything runs in
 * a throwaway schema that is dropped at the end.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as ErrorsModule from '../src/http/errors';
import type * as CheckoutServiceModule from '../src/modules/checkout/service';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-test';

describe('checkout holds (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  // Dynamic imports for the same reason as seat-inventory.test.ts (config validation + PGOPTIONS).
  let db: typeof PoolModule;
  let organiser: typeof OrganiserServiceModule;
  let checkout: typeof CheckoutServiceModule;
  let errors: typeof ErrorsModule;

  /** A concert with one GA row (S$100, max 4 per order) and one VIP row (S$250, max 2), sale open. */
  async function createOnSaleConcert() {
    const day = 24 * 60 * 60 * 1000;
    const concert = await organiser.createConcert(ORGANISER, {
      title: `Checkout ${randomUUID()}`,
      artist: 'Test Artist',
      venueName: 'Test Hall',
      saleStartsAt: new Date(Date.now() + day).toISOString(),
      saleEndsAt: new Date(Date.now() + 2 * day).toISOString(),
      startsAt: new Date(Date.now() + 3 * day).toISOString(),
    });
    await organiser.replaceTicketTypes(ORGANISER, concert.id, {
      ticketTypes: [
        { name: 'GA', priceCents: 10_000, currency: 'SGD', quantity: 6, maxPerOrder: 4 },
        { name: 'VIP', priceCents: 25_000, currency: 'SGD', quantity: 3, maxPerOrder: 2 },
      ],
    });
    await organiser.replaceLayout(ORGANISER, concert.id, {
      sections: [
        {
          name: 'Floor',
          rows: [
            { label: 'A', ticketTypeName: 'VIP', seats: { from: 1, to: 3 } },
            { label: 'B', ticketTypeName: 'GA', seats: { from: 1, to: 6 } },
          ],
        },
      ],
    });
    await organiser.publishConcert(ORGANISER, concert.id);
    await openSale(concert.id);
    const { rows } = await db.query<{ id: string; label: string }>(
      `SELECT s.id, r.label || s.seat_number AS label
         FROM seats s JOIN rows r ON r.id = s.row_id
        WHERE s.concert_id = $1`,
      [concert.id],
    );
    const seat = Object.fromEntries(rows.map((r) => [r.label, r.id])) as Record<string, string>;
    return { concertId: concert.id, seat };
  }

  async function openSale(concertId: string) {
    await db.query(`UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = $1`, [concertId]);
  }

  const httpError = (status: number, code: string) => (err: unknown) =>
    err instanceof errors.HttpError && err.status === status && err.code === code;

  before(async () => {
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    organiser = await import('../src/modules/organiser/service.js');
    checkout = await import('../src/modules/checkout/service.js');
    errors = await import('../src/http/errors.js');
  });

  after(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('holds the seats and creates a pending order with subtotal, fee and total', async () => {
    const { concertId, seat } = await createOnSaleConcert();
    const hold = await checkout.createHold('fan-1', { concertId, seatIds: [seat.A1!, seat.B1!] });

    assert.equal(hold.status, 'pending');
    assert.equal(hold.currency, 'SGD');
    assert.equal(hold.subtotalCents, 35_000);
    assert.equal(hold.bookingFeeCents, 2 * checkout.BOOKING_FEE_CENTS_PER_SEAT);
    assert.equal(hold.totalCents, hold.subtotalCents + hold.bookingFeeCents);
    assert.deepEqual(hold.seats.map((s) => `${s.row}${s.seatNumber}`), ['A1', 'B1']);

    const { rows } = await db.query<{ status: string; held_by: string; hold_id: string; expires_match: boolean }>(
      `SELECT s.status, s.held_by, s.hold_id, s.hold_expires_at = o.expires_at AS expires_match
         FROM seats s JOIN orders o ON o.hold_id = s.hold_id
        WHERE s.id = ANY($1::uuid[])`,
      [[seat.A1, seat.B1]],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'held' && r.held_by === 'fan-1' && r.hold_id === hold.holdId));
    assert.ok(rows.every((r) => r.expires_match), 'order expiry equals the seats hold expiry');
  });

  test('a seat someone else holds: 409 naming that seat, and nothing is held', async () => {
    const { concertId, seat } = await createOnSaleConcert();
    await checkout.createHold('fan-a', { concertId, seatIds: [seat.B1!] });

    await assert.rejects(checkout.createHold('fan-b', { concertId, seatIds: [seat.B1!, seat.B2!] }), (err) => {
      assert.ok(httpError(409, 'seats_unavailable')(err));
      assert.deepEqual((err as ErrorsModule.HttpError).details, { seatIds: [seat.B1] });
      return true;
    });
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders WHERE fan_id = 'fan-b'`,
    );
    assert.equal(rows[0]!.n, 0);
    const b2 = await db.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [seat.B2]);
    assert.equal(b2.rows[0]!.status, 'available');
  });

  test('one active hold per fan per concert', async () => {
    const { concertId, seat } = await createOnSaleConcert();
    const first = await checkout.createHold('fan-1', { concertId, seatIds: [seat.B1!] });
    await assert.rejects(checkout.createHold('fan-1', { concertId, seatIds: [seat.B2!] }), (err) => {
      assert.ok(httpError(409, 'active_hold_exists')(err));
      assert.equal(((err as ErrorsModule.HttpError).details as { holdId: string }).holdId, first.holdId);
      return true;
    });

    // Once that hold has expired, the fan can start again.
    await db.query(
      `UPDATE orders SET expires_at = now() - interval '1 second' WHERE hold_id = $1`,
      [first.holdId],
    );
    await checkout.createHold('fan-1', { concertId, seatIds: [seat.B2!] });
  });

  test('refuses concerts that are not on sale', async () => {
    const { concertId, seat } = await createOnSaleConcert();
    // Sale window already closed (the start can't move once the sale has opened; the end can).
    await db.query(`UPDATE concerts SET sale_ends_at = now() - interval '1 second' WHERE id = $1`, [concertId]);
    await assert.rejects(checkout.createHold('fan-1', { concertId, seatIds: [seat.B1!] }), httpError(409, 'not_on_sale'));

    const other = await createOnSaleConcert();
    await organiser.cancelConcert(ORGANISER, other.concertId, 'Artist unwell');
    await assert.rejects(
      checkout.createHold('fan-1', { concertId: other.concertId, seatIds: [other.seat.B1!] }),
      httpError(409, 'not_on_sale'),
    );

    await assert.rejects(
      checkout.createHold('fan-1', { concertId: randomUUID(), seatIds: [seat.B1!] }),
      httpError(404, 'not_found'),
    );
  });

  test('rejects seats from another concert and too many seats of one ticket type', async () => {
    const { concertId, seat } = await createOnSaleConcert();
    const other = await createOnSaleConcert();
    await assert.rejects(
      checkout.createHold('fan-1', { concertId, seatIds: [seat.B1!, other.seat.B1!] }),
      httpError(400, 'unknown_seats'),
    );
    await assert.rejects(
      checkout.createHold('fan-1', { concertId, seatIds: [seat.A1!, seat.A2!, seat.A3!] }),
      httpError(400, 'too_many_seats'),
    );
  });

  test('a sold seat must name an existing order', async () => {
    const { seat } = await createOnSaleConcert();
    await assert.rejects(
      db.query(`UPDATE seats SET status = 'sold', sold_at = now() WHERE id = $1`, [seat.B1]),
      { code: '23514', constraint: 'seats_sold_chk' },
    );
    await assert.rejects(
      db.query(`UPDATE seats SET status = 'sold', sold_at = now(), order_id = $2 WHERE id = $1`, [seat.B1, randomUUID()]),
      { code: '23503', constraint: 'seats_order_fk' },
    );
  });
});
