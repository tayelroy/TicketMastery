/**
 * Integration tests for the public UC1 discovery routes (GET /api/concerts, /:id, /:id/seats), driven over
 * HTTP against the real Express app. Needs a real Postgres, like seat-inventory.test.ts: skipped when
 * DB_HOST is unset, and runs in a throwaway schema that is dropped at the end.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as SeatHoldsModule from '../src/db/seat-holds';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-test';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('concert discovery (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  // Dynamic imports for the same reason as seat-inventory.test.ts (config validation + PGOPTIONS).
  let db: typeof PoolModule;
  let service: typeof OrganiserServiceModule;
  let holds: typeof SeatHoldsModule;
  let server: Server;
  let baseUrl: string;

  async function get(path: string) {
    const res = await fetch(`${baseUrl}/api/concerts${path}`);
    return { status: res.status, cacheControl: res.headers.get('cache-control'), body: (await res.json()) as any };
  }

  /** Concert with CAT1 (row A, 2 seats, $188) and CAT2 (row B, 3 seats, $128) in one section. */
  async function createConcert(opts: { title: string; artist: string; startsInDays: number; publish: boolean }) {
    const concert = await service.createConcert(ORGANISER, {
      title: opts.title,
      artist: opts.artist,
      venueName: 'Test Hall',
      saleStartsAt: new Date(Date.now() + DAY_MS).toISOString(),
      saleEndsAt: new Date(Date.now() + (opts.startsInDays - 1) * DAY_MS).toISOString(),
      startsAt: new Date(Date.now() + opts.startsInDays * DAY_MS).toISOString(),
    });
    await service.replaceTicketTypes(ORGANISER, concert.id, {
      ticketTypes: [
        { name: 'CAT1', priceCents: 18_800, currency: 'SGD', quantity: 2, maxPerOrder: 4 },
        { name: 'CAT2', priceCents: 12_800, currency: 'SGD', quantity: 3, maxPerOrder: 4 },
      ],
    });
    await service.replaceLayout(ORGANISER, concert.id, {
      sections: [
        {
          name: 'Floor',
          rows: [
            { label: 'A', ticketTypeName: 'CAT1', seats: { from: 1, to: 2 } },
            { label: 'B', ticketTypeName: 'CAT2', seatNumbers: ['10', '2', '2A'] },
          ],
        },
      ],
    });
    if (opts.publish) await service.publishConcert(ORGANISER, concert.id);
    return concert.id;
  }

  let early: string;
  let late: string;
  let draft: string;

  before(async () => {
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    service = await import('../src/modules/organiser/service.js');
    holds = await import('../src/db/seat-holds.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    early = await createConcert({ title: 'Early Show', artist: 'Alpha Band', startsInDays: 10, publish: true });
    late = await createConcert({ title: 'Late Show', artist: 'Beta_Band', startsInDays: 20, publish: true });
    draft = await createConcert({ title: 'Draft Show', artist: 'Alpha Band', startsInDays: 5, publish: false });
  });

  after(async () => {
    server?.close();
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('lists published upcoming concerts in start order with the cheapest price, hiding drafts', async () => {
    const { status, cacheControl, body } = await get('/');
    assert.equal(status, 200);
    assert.match(cacheControl ?? '', /public/);
    assert.deepEqual(
      body.concerts.map((c: any) => c.id),
      [early, late],
    );
    assert.equal(body.concerts[0].minPriceCents, 12_800);
    assert.equal(body.concerts[0].currency, 'SGD');
    assert.equal(body.concerts[0].venueName, 'Test Hall');
    assert.equal(body.concerts[0].organiserId, undefined);
  });

  test('filters by search text, artist and date window, treating LIKE wildcards literally', async () => {
    assert.deepEqual((await get('/?q=late')).body.concerts.map((c: any) => c.id), [late]);
    assert.deepEqual((await get('/?artist=beta_')).body.concerts.map((c: any) => c.id), [late]);
    // "_" must not act as a single-character wildcard ("Alpha Band" has a space there).
    assert.deepEqual((await get('/?artist=alpha_band')).body.concerts, []);
    const to = new Date(Date.now() + 15 * DAY_MS).toISOString();
    assert.deepEqual((await get(`/?to=${encodeURIComponent(to)}`)).body.concerts.map((c: any) => c.id), [early]);
    assert.deepEqual((await get('/?limit=1&offset=1')).body.concerts.map((c: any) => c.id), [late]);
  });

  test('rejects bad query params with 400', async () => {
    assert.equal((await get('/?limit=0')).status, 400);
    assert.equal((await get('/?from=yesterday')).status, 400);
  });

  test('concert detail returns ticket types with availability; drafts and bad ids 404/400', async () => {
    const { status, body } = await get(`/${early}`);
    assert.equal(status, 200);
    assert.equal(body.title, 'Early Show');
    assert.deepEqual(
      body.ticketTypes.map((t: any) => [t.name, t.priceCents, t.available, t.total]),
      [
        ['CAT1', 18_800, 2, 2],
        ['CAT2', 12_800, 3, 3],
      ],
    );
    assert.equal((await get(`/${draft}`)).status, 404);
    assert.equal((await get(`/${randomUUID()}`)).status, 404);
    assert.equal((await get('/not-a-uuid')).status, 400);
  });

  test('seat map nests sections/rows/seats in display order and shows live hold state', async () => {
    await db.query(`UPDATE concerts SET status = 'on_sale', sale_starts_at = now() - interval '1 minute' WHERE id = $1`, [
      late,
    ]);
    const first = await get(`/${late}/seats`);
    assert.equal(first.status, 200);
    assert.equal(first.cacheControl, 'no-store');
    const [section] = first.body.sections;
    assert.equal(section.name, 'Floor');
    assert.deepEqual(
      section.rows.map((r: any) => [r.label, r.seats.map((s: any) => s.seatNumber)]),
      [
        ['A', ['1', '2']],
        ['B', ['2', '2A', '10']],
      ],
    );

    const [activeSeat, expiredSeat] = section.rows[0].seats.map((s: any) => s.id as string);
    await db.withTransaction((tx) => holds.holdSeats(tx, { concertId: late, seatIds: [activeSeat!], fanId: 'fan-a', holdId: randomUUID() }));
    await db.withTransaction((tx) => holds.holdSeats(tx, { concertId: late, seatIds: [expiredSeat!], fanId: 'fan-b', holdId: randomUUID() }));
    await db.query(
      `UPDATE seats SET held_at = now() - interval '11 minutes', hold_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expiredSeat],
    );

    const rowA = (await get(`/${late}/seats`)).body.sections[0].rows[0].seats;
    assert.deepEqual(
      rowA.map((s: any) => s.status),
      ['held', 'available'],
    );
    assert.equal(rowA[0].heldBy, undefined);

    const cat1 = (await get(`/${late}`)).body.ticketTypes.find((t: any) => t.name === 'CAT1');
    assert.equal(cat1.available, 1);
  });

  test('seat map 404s for drafts', async () => {
    assert.equal((await get(`/${draft}/seats`)).status, 404);
  });
});
