/**
 * UC5 GET /api/organiser/reports/sales against Postgres, through the real createApp() in AUTH_MODE=dev-header.
 * Orders are made by the real UC5 + UC4 services; confirmed_at is then moved back a number of days so the date
 * range is tested relative to today in Singapore. Skipped when DB_HOST is unset; runs in a throwaway schema.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as CheckoutServiceModule from '../src/modules/checkout/service';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-reports';
const OTHER_ORGANISER = 'org-reports-other';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The JSON body (timestamps are strings on the wire but no test reads them), or an API error. */
type Report = Awaited<ReturnType<typeof OrganiserServiceModule.getSalesReport>> & { error: { code: string } };
const SECTIONS = ['totals', 'byConcert', 'byDay', 'byTicketType', 'seatStatus', 'recentOrders'] as const;

describe('UC5 sales reports (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  let db: typeof PoolModule;
  let organiser: typeof OrganiserServiceModule;
  let checkout: typeof CheckoutServiceModule;
  let server: Server;
  let baseUrl: string;

  const concert = {} as Record<'a' | 'b' | 'other', string>;
  const order = {} as Record<'aToday' | 'a3' | 'a20' | 'a100' | 'b1' | 'other', string>;

  /** A published concert with one GA row of `quantity` seats, sale open. Returns its id and seat ids by label. */
  async function createOnSaleConcert(organiserId: string, priceCents: number, quantity: number) {
    const concert = await organiser.createConcert(organiserId, {
      title: `Report ${randomUUID()}`,
      artist: 'Test Artist',
      venueName: 'Test Hall',
      saleStartsAt: new Date(Date.now() + DAY_MS).toISOString(),
      saleEndsAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
      startsAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    });
    await organiser.replaceTicketTypes(organiserId, concert.id, {
      ticketTypes: [{ name: 'GA', priceCents, currency: 'SGD', quantity, maxPerOrder: 4 }],
    });
    await organiser.replaceLayout(organiserId, concert.id, {
      sections: [{ name: 'Floor', rows: [{ label: 'A', ticketTypeName: 'GA', seats: { from: 1, to: quantity } }] }],
    });
    await organiser.publishConcert(organiserId, concert.id);
    await db.query(`UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = $1`, [concert.id]);
    const { rows } = await db.query<{ id: string; label: string }>(
      `SELECT s.id, r.label || s.seat_number AS label FROM seats s JOIN rows r ON r.id = s.row_id
        WHERE s.concert_id = $1`,
      [concert.id],
    );
    return { id: concert.id, seat: Object.fromEntries(rows.map((r) => [r.label, r.id])) as Record<string, string> };
  }

  /** Holds and pays like the checkout page, then moves the payment `daysAgo` days back. Returns the order id. */
  async function buy(fanId: string, concertId: string, seatIds: string[], daysAgo: number) {
    const hold = await checkout.createHold(fanId, { concertId, seatIds });
    const { orderId } = await checkout.confirmHold(fanId, hold.holdId, { simulatePaymentFailure: false });
    await db.query(`UPDATE orders SET confirmed_at = now() - make_interval(days => $2) WHERE id = $1`, [
      orderId,
      daysAgo,
    ]);
    return orderId;
  }

  async function get(path: string, organiserId = ORGANISER) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { 'x-dev-user-id': organiserId, 'x-dev-user-groups': 'organisers' },
    });
    return { status: res.status, cacheControl: res.headers.get('cache-control'), body: (await res.json()) as Report };
  }

  /** Today in Singapore shifted by `offset` days, as YYYY-MM-DD. */
  const sgtDay = (offset: number) =>
    new Date(Date.now() + 8 * 60 * 60 * 1000 + offset * DAY_MS).toISOString().slice(0, 10);

  before(async () => {
    // Dynamic imports, like checkout.test.ts: config is validated and PGOPTIONS read when the modules load.
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    Object.assign(process.env, { AUTH_MODE: 'dev-header', LOG_LEVEL: 'silent' });
    delete process.env.ORDER_EVENTS_TOPIC_ARN;
    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    organiser = await import('../src/modules/organiser/service.js');
    checkout = await import('../src/modules/checkout/service.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A: S$100 seats, sold today (2 seats), 3, 20 and 100 days ago (1 seat each). S$4 booking fee per seat.
    const a = await createOnSaleConcert(ORGANISER, 10_000, 10);
    concert.a = a.id;
    order.aToday = await buy('fan-a', a.id, [a.seat.A1!, a.seat.A2!], 0);
    order.a3 = await buy('fan-b', a.id, [a.seat.A3!], 3);
    order.a20 = await buy('fan-c', a.id, [a.seat.A4!], 20);
    order.a100 = await buy('fan-d', a.id, [a.seat.A5!], 100);
    // Checkout attempts on A that are not sales: an active hold and a declined payment.
    await checkout.createHold('fan-e', { concertId: a.id, seatIds: [a.seat.A6!] });
    const declined = await checkout.createHold('fan-f', { concertId: a.id, seatIds: [a.seat.A7!] });
    await assert.rejects(checkout.confirmHold('fan-f', declined.holdId, { simulatePaymentFailure: true }));

    // B: S$50 seats, one sold yesterday.
    const b = await createOnSaleConcert(ORGANISER, 5_000, 4);
    concert.b = b.id;
    order.b1 = await buy('fan-g', b.id, [b.seat.A1!], 1);

    // Another organiser's sale today: never in ORGANISER's report.
    const other = await createOnSaleConcert(OTHER_ORGANISER, 7_000, 4);
    concert.other = other.id;
    order.other = await buy('fan-h', other.id, [other.seat.A1!], 0);
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('last 7 days: only my confirmed orders in the range, not cached', async () => {
    const res = await get('/api/organiser/reports/sales?days=7');
    assert.equal(res.status, 200);
    assert.equal(res.cacheControl, 'no-store');
    assert.deepEqual(res.body.range, { days: 7, from: sgtDay(-6), to: sgtDay(0) });
    assert.equal(res.body.concertId, null);
    assert.deepEqual(res.body.totals, [
      {
        currency: 'SGD',
        confirmedOrders: 3,
        seatsSold: 4,
        ticketRevenueCents: 35_000,
        bookingFeeCents: 1_600,
        grossRevenueCents: 36_600,
        averageOrderCents: 12_200,
      },
    ]);
    assert.deepEqual(
      res.body.byConcert.map((c) => [c.concertId, c.status, c.confirmedOrders, c.seatsSold, c.grossRevenueCents]),
      [
        [concert.a, 'scheduled', 2, 3, 31_200],
        [concert.b, 'scheduled', 1, 1, 5_400],
      ],
    );
    // Newest first; the other organiser's order, the 20/100-day-old ones and the non-sales are not there.
    assert.deepEqual(
      res.body.recentOrders.map((o) => [o.orderId, o.seats, o.grossRevenueCents, o.currency]),
      [
        [order.aToday, 2, 20_800, 'SGD'],
        [order.b1, 1, 5_400, 'SGD'],
        [order.a3, 1, 10_400, 'SGD'],
      ],
    );
    assert.ok(!('fanId' in res.body.recentOrders[0]!));
  });

  test('by day: every Singapore day of the range, zero-filled', async () => {
    const { body } = await get('/api/organiser/reports/sales?days=7');
    const gross: Record<number, number> = { 0: 20_800, [-1]: 5_400, [-3]: 10_400 };
    assert.deepEqual(
      body.byDay,
      [-6, -5, -4, -3, -2, -1, 0].map((offset) => ({
        date: sgtDay(offset),
        currency: 'SGD',
        confirmedOrders: gross[offset] ? 1 : 0,
        seatsSold: offset === 0 ? 2 : gross[offset] ? 1 : 0,
        grossRevenueCents: gross[offset] ?? 0,
      })),
    );
  });

  test('wider ranges take older orders in; all time starts at the first sale', async () => {
    const count = async (days: string) => (await get(`/api/organiser/reports/sales?days=${days}`)).body;
    assert.equal((await count('30')).totals[0]?.confirmedOrders, 4);
    assert.equal((await count('90')).totals[0]?.confirmedOrders, 4);
    const all = await count('all');
    assert.deepEqual(all.range, { days: null, from: null, to: sgtDay(0) });
    assert.equal(all.totals[0]?.confirmedOrders, 5);
    assert.equal(all.byDay.length, 101);
    assert.equal(all.byDay[0]?.date, sgtDay(-100));
    assert.equal(all.byDay[0]?.grossRevenueCents, 10_400);
    // Without days the range is 30 days.
    assert.deepEqual((await get('/api/organiser/reports/sales')).body.range, (await count('30')).range);
  });

  test('totals equal the sum of byConcert per currency', async () => {
    for (const days of ['7', '30', '90', 'all']) {
      const { body } = await get(`/api/organiser/reports/sales?days=${days}`);
      for (const t of body.totals) {
        const rows = body.byConcert.filter((c) => c.currency === t.currency);
        const keys = [
          'confirmedOrders',
          'seatsSold',
          'ticketRevenueCents',
          'bookingFeeCents',
          'grossRevenueCents',
        ] as const;
        for (const key of keys) {
          assert.equal(
            t[key],
            rows.reduce((n, c) => n + c[key], 0),
            `${days} ${key}`,
          );
        }
      }
    }
  });

  test('ticket types are all time, seat status is now', async () => {
    const { body } = await get('/api/organiser/reports/sales?days=7');
    assert.deepEqual(
      body.byTicketType
        .filter((t) => t.concertId === concert.a)
        .map((t) => [t.ticketTypeName, t.confirmedOrders, t.seatsSold, t.ticketRevenueCents]),
      [['GA', 4, 5, 50_000]],
    );
    assert.ok(!body.byTicketType.some((t) => t.concertId === concert.other));
    assert.deepEqual(
      // A starts a few milliseconds before B (concerts are ordered by start time).
      body.seatStatus.map((s) => [s.concertId, s.available, s.held, s.sold, s.total]),
      [
        [concert.a, 4, 1, 5, 10],
        [concert.b, 3, 0, 1, 4],
      ],
    );
  });

  test('concertId narrows every section to that concert', async () => {
    const { status, body } = await get(`/api/organiser/reports/sales?days=30&concertId=${concert.b}`);
    assert.equal(status, 200);
    assert.equal(body.concertId, concert.b);
    assert.equal(body.totals[0]?.grossRevenueCents, 5_400);
    for (const section of ['byConcert', 'byTicketType', 'seatStatus', 'recentOrders'] as const) {
      assert.ok(body[section].length > 0, section);
      assert.ok(
        body[section].every((r) => r.concertId === concert.b),
        section,
      );
    }
    assert.equal(
      body.byDay.reduce((n, d) => n + d.grossRevenueCents, 0),
      5_400,
    );
  });

  test('someone else’s concert is 403, a missing one 404, like the other organiser routes', async () => {
    const theirs = await get(`/api/organiser/reports/sales?concertId=${concert.other}`);
    assert.equal(theirs.status, 403);
    assert.equal(theirs.body.error.code, 'forbidden');
    const missing = await get(`/api/organiser/reports/sales?concertId=${randomUUID()}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
    // The other organiser sees only their own sale.
    const other = await get('/api/organiser/reports/sales?days=7', OTHER_ORGANISER);
    assert.deepEqual(
      other.body.recentOrders.map((o) => o.orderId),
      [order.other],
    );
  });

  test('an organiser without sales gets empty sections', async () => {
    const { status, body } = await get('/api/organiser/reports/sales?days=all', 'org-reports-nobody');
    assert.equal(status, 200);
    for (const section of SECTIONS) {
      assert.deepEqual(body[section], [], section);
    }
  });

  test('invalid days or concertId: 400 validation_error', async () => {
    for (const query of ['days=5', 'days=all&concertId=not-a-uuid']) {
      const res = await get(`/api/organiser/reports/sales?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, 'validation_error', query);
    }
  });
});
