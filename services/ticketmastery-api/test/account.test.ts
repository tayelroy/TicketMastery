/**
 * Integration tests for UC2 My Tickets: /api/me/orders, /api/me/tickets/:ticketId and its download, through the real
 * app (dev-header auth) against Postgres. Orders are made by the real UC5 + UC4 services (publish a concert, hold,
 * pay), so these tests break if UC4's tables change under UC2's query.
 * Needs a real Postgres, like checkout.test.ts: skipped when DB_HOST is unset, and everything runs in a throwaway
 * schema that is dropped at the end.
 */
import { S3Client } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as CheckoutServiceModule from '../src/modules/checkout/service';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-test';
const BUCKET = 'tm-test-tickets';
const IMAGE_URL = 'https://images.example.com/poster.jpg';

describe('UC2 my tickets (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  // Dynamic imports for the same reason as checkout.test.ts (config validation + PGOPTIONS).
  let db: typeof PoolModule;
  let organiser: typeof OrganiserServiceModule;
  let checkout: typeof CheckoutServiceModule;
  let server: Server;
  let baseUrl: string;

  /** Order ids by name; see before() for what each one is. */
  const order: Record<string, string> = {};
  let concertId: string;
  let cancelledConcertId: string;

  /** A published concert with VIP row A1-3 (S$250) and GA row B1-10 (S$100), sale open. Returns seat ids by label. */
  async function createOnSaleConcert() {
    const day = 24 * 60 * 60 * 1000;
    const concert = await organiser.createConcert(ORGANISER, {
      title: `My Tickets ${randomUUID()}`,
      artist: 'Test Artist',
      venueName: 'Test Hall',
      imageUrl: IMAGE_URL,
      saleStartsAt: new Date(Date.now() + day).toISOString(),
      saleEndsAt: new Date(Date.now() + 2 * day).toISOString(),
      startsAt: new Date(Date.now() + 3 * day).toISOString(),
    });
    await organiser.replaceTicketTypes(ORGANISER, concert.id, {
      ticketTypes: [
        { name: 'GA', priceCents: 10_000, currency: 'SGD', quantity: 10, maxPerOrder: 4 },
        { name: 'VIP', priceCents: 25_000, currency: 'SGD', quantity: 3, maxPerOrder: 2 },
      ],
    });
    await organiser.replaceLayout(ORGANISER, concert.id, {
      sections: [
        {
          name: 'Floor',
          rows: [
            { label: 'A', ticketTypeName: 'VIP', seats: { from: 1, to: 3 } },
            { label: 'B', ticketTypeName: 'GA', seats: { from: 1, to: 10 } },
          ],
        },
      ],
    });
    await organiser.publishConcert(ORGANISER, concert.id);
    await db.query(`UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = $1`, [concert.id]);
    const { rows } = await db.query<{ id: string; label: string }>(
      `SELECT s.id, r.label || s.seat_number AS label FROM seats s JOIN rows r ON r.id = s.row_id
        WHERE s.concert_id = $1`,
      [concert.id],
    );
    return { id: concert.id, seat: Object.fromEntries(rows.map((r) => [r.label, r.id])) as Record<string, string> };
  }

  /** Holds and pays, like the checkout page. */
  async function buy(fanId: string, concert: string, seatIds: string[]) {
    const hold = await checkout.createHold(fanId, { concertId: concert, seatIds });
    await checkout.confirmHold(fanId, hold.holdId, { simulatePaymentFailure: false });
    return orderIdOf(hold.holdId);
  }

  async function orderIdOf(holdId: string) {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM orders WHERE hold_id = $1', [holdId]);
    return rows[0]!.id;
  }

  async function get(path: string, fanId: string) {
    const res = await fetch(`${baseUrl}${path}`, { headers: { 'x-dev-user-id': fanId } });
    return { status: res.status, cacheControl: res.headers.get('cache-control'), body: (await res.json()) as any };
  }

  before(async () => {
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    Object.assign(process.env, {
      AUTH_MODE: 'dev-header',
      LOG_LEVEL: 'silent',
      TICKET_PDF_BUCKET: BUCKET,
      // Fake AWS credentials: signing a link is local, and nothing in this file may reach AWS.
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTONLY0000',
      AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
    });
    delete process.env.AWS_PROFILE; // with it set, the SDK skips the key variables above
    delete process.env.AWS_SESSION_TOKEN;
    // The download checks the PDF exists with HeadObject: answer "it does" (account-download.test.ts covers the rest).
    mock.method(S3Client.prototype, 'send', async () => ({}));

    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    organiser = await import('../src/modules/organiser/service.js');
    checkout = await import('../src/modules/checkout/service.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const c = await createOnSaleConcert();
    concertId = c.id;
    // fan-a: two confirmed orders on this concert. Seats are picked out of seat-map order on purpose, and B10 checks
    // that seat numbers sort as numbers (B2 before B10), not as text.
    order.first = await buy('fan-a', c.id, [c.seat.B10!, c.seat.B2!, c.seat.A1!]);
    order.second = await buy('fan-a', c.id, [c.seat.B1!]);
    // fan-b: one confirmed order.
    order.otherFan = await buy('fan-b', c.id, [c.seat.B3!]);

    // fan-a checkout attempts that never became tickets.
    const released = await checkout.createHold('fan-a', { concertId: c.id, seatIds: [c.seat.B4!] });
    await checkout.releaseHold('fan-a', released.holdId);
    order.released = await orderIdOf(released.holdId);
    const declined = await checkout.createHold('fan-a', { concertId: c.id, seatIds: [c.seat.B5!] });
    await assert.rejects(checkout.confirmHold('fan-a', declined.holdId, { simulatePaymentFailure: true }));
    order.declined = await orderIdOf(declined.holdId);
    const late = await checkout.createHold('fan-a', { concertId: c.id, seatIds: [c.seat.B6!] });
    await db.query(`UPDATE orders SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [late.holdId]);
    await assert.rejects(checkout.confirmHold('fan-a', late.holdId, { simulatePaymentFailure: false }));
    order.expired = await orderIdOf(late.holdId);
    order.pending = await orderIdOf(
      (await checkout.createHold('fan-a', { concertId: c.id, seatIds: [c.seat.A2!] })).holdId,
    );

    // fan-a's newest order is for a concert the organiser cancelled afterwards.
    const cancelled = await createOnSaleConcert();
    cancelledConcertId = cancelled.id;
    order.cancelledConcert = await buy('fan-a', cancelled.id, [cancelled.seat.B1!]);
    await organiser.cancelConcert(ORGANISER, cancelled.id, 'Artist unwell');
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('the fixture orders have the statuses the other tests rely on', async () => {
    const { rows } = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM orders WHERE id = ANY($1::uuid[])',
      [Object.values(order)],
    );
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    assert.deepEqual(Object.fromEntries(Object.entries(order).map(([name, id]) => [name, status[id]])), {
      first: 'confirmed',
      second: 'confirmed',
      otherFan: 'confirmed',
      released: 'cancelled',
      declined: 'cancelled',
      expired: 'expired',
      pending: 'pending',
      cancelledConcert: 'confirmed',
    });
  });

  test("GET /api/me/orders: only the caller's confirmed orders, newest first, marked no-store", async () => {
    const mine = await get('/api/me/orders', 'fan-a');
    assert.equal(mine.status, 200);
    assert.equal(mine.cacheControl, 'no-store');
    assert.deepEqual(
      mine.body.orders.map((o: { orderId: string }) => o.orderId),
      [order.cancelledConcert, order.second, order.first],
    );

    const other = await get('/api/me/orders', 'fan-b');
    assert.deepEqual(
      other.body.orders.map((o: { orderId: string }) => o.orderId),
      [order.otherFan],
    );
    assert.deepEqual(await get('/api/me/orders', 'fan-with-no-orders'), {
      status: 200,
      cacheControl: 'no-store',
      body: { orders: [] },
    });
  });

  test('an order carries its concert, money and seats in seat-map order', async () => {
    const { rows } = await db.query<{ confirmed_at: Date; starts_at: Date; title: string }>(
      `SELECT o.confirmed_at, c.starts_at, c.title FROM orders o JOIN concerts c ON c.id = o.concert_id
        WHERE o.id = $1`,
      [order.first],
    );
    const expected = {
      orderId: order.first,
      confirmedAt: rows[0]!.confirmed_at.toISOString(),
      currency: 'SGD',
      subtotalCents: 45_000,
      bookingFeeCents: 3 * checkout.BOOKING_FEE_CENTS_PER_SEAT,
      totalCents: 45_000 + 3 * checkout.BOOKING_FEE_CENTS_PER_SEAT,
      concert: {
        id: concertId,
        title: rows[0]!.title,
        artist: 'Test Artist',
        venueName: 'Test Hall',
        startsAt: rows[0]!.starts_at.toISOString(),
        imageUrl: IMAGE_URL,
        status: 'scheduled',
      },
      seats: [
        { section: 'Floor', row: 'A', seatNumber: '1', ticketType: 'VIP', priceCents: 25_000 },
        { section: 'Floor', row: 'B', seatNumber: '2', ticketType: 'GA', priceCents: 10_000 },
        { section: 'Floor', row: 'B', seatNumber: '10', ticketType: 'GA', priceCents: 10_000 },
      ],
    };

    const list = (await get('/api/me/orders', 'fan-a')).body.orders;
    assert.deepEqual(
      list.find((o: { orderId: string }) => o.orderId === order.first),
      expected,
    );
    assert.deepEqual(await get(`/api/me/tickets/${order.first}`, 'fan-a'), {
      status: 200,
      cacheControl: 'no-store',
      body: expected,
    });
  });

  test('a concert cancelled after purchase keeps the ticket, with the concert marked cancelled', async () => {
    const res = await get(`/api/me/tickets/${order.cancelledConcert}`, 'fan-a');
    assert.equal(res.status, 200);
    assert.equal(res.body.concert.id, cancelledConcertId);
    assert.equal(res.body.concert.status, 'cancelled');
  });

  test("GET /api/me/tickets/:ticketId: 404 for someone else's order, an unconfirmed one or an unknown id", async () => {
    const notFound = { error: { code: 'not_found', message: 'Ticket not found' } };
    const cases: [string, string][] = [
      ['fan-b', order.first!],
      ['fan-a', order.otherFan!],
      ['fan-a', order.pending!],
      ['fan-a', order.released!],
      ['fan-a', order.declined!],
      ['fan-a', order.expired!],
      ['fan-a', randomUUID()],
    ];
    for (const [fan, id] of cases) {
      for (const path of [`/api/me/tickets/${id}`, `/api/me/tickets/${id}/download`]) {
        const res = await get(path, fan);
        assert.equal(res.status, 404, `${fan} ${path}`);
        assert.deepEqual(res.body, notFound, `${fan} ${path}`);
      }
    }
  });

  test("download: a 5-minute signed link to the caller's order PDF", async () => {
    const res = await get(`/api/me/tickets/${order.second}/download`, 'fan-a');
    assert.equal(res.status, 200);
    assert.equal(res.cacheControl, 'no-store');
    assert.equal(res.body.expiresInSeconds, 300);
    const link = new URL(res.body.url);
    assert.equal(link.origin, `https://${BUCKET}.s3.ap-southeast-1.amazonaws.com`);
    assert.equal(link.pathname, `/tickets/${order.second}.pdf`);
    assert.equal(link.searchParams.get('X-Amz-Expires'), '300');
  });

  test('the list stops at 100 orders; an order without seats lists an empty seats array', async () => {
    // Straight SQL: 101 checkouts would need 101 concerts' worth of seats. created_at spreads them a second apart.
    await db.query(
      `INSERT INTO orders (fan_id, concert_id, hold_id, status, currency, subtotal_cents, booking_fee_cents,
                           total_cents, expires_at, confirmed_at, created_at)
       SELECT 'fan-many', $1, gen_random_uuid(), 'confirmed', 'SGD', 100, 0, 100, now(), now(),
              now() - make_interval(secs => i)
         FROM generate_series(1, 101) AS i`,
      [concertId],
    );
    const { body } = await get('/api/me/orders', 'fan-many');
    assert.equal(body.orders.length, 100);
    assert.deepEqual(body.orders[0].seats, []);
    const created = body.orders.map((o: { confirmedAt: string }) => o.confirmedAt);
    assert.equal(new Set(created).size, 1, 'same confirmed_at, so the order below comes from created_at alone');
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM orders WHERE fan_id = 'fan-many' ORDER BY created_at DESC LIMIT 100`,
    );
    assert.deepEqual(
      body.orders.map((o: { orderId: string }) => o.orderId),
      rows.map((r) => r.id),
    );
  });
});
