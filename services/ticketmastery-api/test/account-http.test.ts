/**
 * UC2 /api/me through Express in AUTH_MODE=cognito, no database: the real createApp() on an ephemeral port, tokens
 * from the throwaway pool key. Covers everything decided before any SQL runs (sign-in, the ticket id, a missing PDF
 * bucket), signs a download link offline, and runs the order routes on canned rows (pool.query mocked) so the
 * coverage gate holds without Postgres. What the SQL itself returns is tested in account.test.ts (Postgres).
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as AccountServiceModule from '../src/modules/account/service';
import { cognitoEnv, FakeJwksEndpoint, makeToken, poolKey } from './helpers/cognito';

const TICKET = '3b0c7f1e-6f43-4c1a-9d43-8a6f1c2b5e10';

describe('UC2 /api/me over HTTP (AUTH_MODE=cognito, no database)', () => {
  let server: Server;
  let baseUrl: string;
  let account: typeof AccountServiceModule;
  let db: typeof PoolModule;
  const jwks = new FakeJwksEndpoint(); // unreachable: every key must come from the cache below

  before(async () => {
    // DB_HOST is 'unused', so any route that reached the database would fail with 500, not the asserted status.
    // Fake AWS credentials: signing a link is local, and nothing in this file may reach AWS.
    Object.assign(process.env, cognitoEnv, {
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTONLY0000',
      AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
    });
    // With AWS_PROFILE set, the SDK skips the key variables above and would look for a real profile instead.
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.TICKET_PDF_BUCKET;
    jwks.install();
    const { cognitoVerifier } = await import('../src/auth/index.js');
    cognitoVerifier!.cacheJwks({ keys: [poolKey.jwk] });
    db = await import('../src/db/pool.js');
    account = await import('../src/modules/account/service.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    jwks.restore();
  });

  async function get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return { status: res.status, cacheControl: res.headers.get('cache-control'), body: (await res.json()) as any };
  }

  const fan = () => ({ Authorization: `Bearer ${makeToken()}` });

  /** One row as Postgres returns it for MY_ORDERS (dates as Date, seats already built by json_agg). */
  const row = (id: string, startsAt: string) => ({
    id,
    currency: 'SGD',
    subtotal_cents: 35_000,
    booking_fee_cents: 400,
    total_cents: 35_400,
    confirmed_at: new Date('2026-10-30T08:00:00.000Z'),
    concert_id: 'c0c0c0c0-0000-4000-8000-000000000001',
    title: 'Night Show',
    artist: 'Test Artist',
    venue_name: 'Test Hall',
    starts_at: new Date(startsAt),
    image_url: null,
    concert_status: 'cancelled',
    seats: [{ section: 'Floor', row: 'B', seatNumber: '2', ticketType: 'GA', priceCents: 10_000 }],
  });
  const dto = (orderId: string, startsAt: string) => ({
    orderId,
    confirmedAt: '2026-10-30T08:00:00.000Z',
    currency: 'SGD',
    subtotalCents: 35_000,
    bookingFeeCents: 400,
    totalCents: 35_400,
    concert: {
      id: 'c0c0c0c0-0000-4000-8000-000000000001',
      title: 'Night Show',
      artist: 'Test Artist',
      venueName: 'Test Hall',
      startsAt,
      imageUrl: null,
      status: 'cancelled',
    },
    seats: [{ section: 'Floor', row: 'B', seatNumber: '2', ticketType: 'GA', priceCents: 10_000 }],
  });

  /** Replaces pool.query for one test: answers with `rows` and records every (sql, params). */
  function fakeQuery(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const query = mock.method(db.pool, 'query', async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows };
    });
    return { calls, restore: () => query.mock.restore() };
  }

  test('no token: 401 unauthenticated on every /api/me route', async () => {
    for (const path of [
      '/api/me',
      '/api/me/orders',
      `/api/me/tickets/${TICKET}`,
      `/api/me/tickets/${TICKET}/download`,
    ]) {
      const res = await get(path);
      assert.equal(res.status, 401, path);
      assert.deepEqual(res.body, { error: { code: 'unauthenticated', message: 'Authentication required' } }, path);
    }
  });

  test("GET /api/me: the token's sub and groups, marked no-store", async () => {
    assert.deepEqual(await get('/api/me', fan()), {
      status: 200,
      cacheControl: 'no-store',
      body: { sub: 'fan-sub-1', groups: [] },
    });

    const organiser = makeToken({ claims: { sub: 'org-sub-9', 'cognito:groups': ['organisers'] } });
    assert.deepEqual((await get('/api/me', { Authorization: `Bearer ${organiser}` })).body, {
      sub: 'org-sub-9',
      groups: ['organisers'],
    });
  });

  test('a ticket id that is not a uuid: 400 before any database access', async () => {
    for (const path of ['/api/me/tickets/42', '/api/me/tickets/42/download']) {
      const res = await get(path, fan());
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error.code, 'validation_error', path);
      assert.deepEqual(
        res.body.error.details.map((d: { path: string }) => d.path),
        ['ticketId'],
        path,
      );
    }
  });

  test('download without TICKET_PDF_BUCKET: 503 not_configured, before looking up the order', async () => {
    assert.deepEqual(await get(`/api/me/tickets/${TICKET}/download`, fan()), {
      status: 503,
      cacheControl: 'no-store',
      body: { error: { code: 'not_configured', message: 'E-ticket downloads are not available yet' } },
    });
  });

  test('an unknown path under /api/me is still behind sign-in, then 404', async () => {
    assert.equal((await get('/api/me/nope')).status, 401);
    assert.equal((await get('/api/me/nope', fan())).status, 404);
  });

  test("GET /api/me/orders: the token's own confirmed orders, newest first, mapped to the order DTO", async () => {
    const OTHER = '9a9a9a9a-0000-4000-8000-000000000002';
    const q = fakeQuery([row(TICKET, '2026-12-01T12:00:00.000Z'), row(OTHER, '2026-11-01T12:00:00.000Z')]);
    try {
      assert.deepEqual(await get('/api/me/orders', fan()), {
        status: 200,
        cacheControl: 'no-store',
        body: { orders: [dto(TICKET, '2026-12-01T12:00:00.000Z'), dto(OTHER, '2026-11-01T12:00:00.000Z')] },
      });
      assert.equal(q.calls.length, 1);
      assert.deepEqual(q.calls[0]!.params, ['fan-sub-1', 100]);
      assert.match(q.calls[0]!.sql, /WHERE o\.fan_id = \$1 AND o\.status = 'confirmed'/);
      assert.match(q.calls[0]!.sql, /ORDER BY o\.created_at DESC, o\.id LIMIT \$2$/);
    } finally {
      q.restore();
    }
  });

  test("GET /api/me/tickets/:ticketId: one order looked up by the token's sub and the id", async () => {
    const q = fakeQuery([row(TICKET, '2026-12-01T12:00:00.000Z')]);
    try {
      assert.deepEqual(await get(`/api/me/tickets/${TICKET}`, fan()), {
        status: 200,
        cacheControl: 'no-store',
        body: dto(TICKET, '2026-12-01T12:00:00.000Z'),
      });
      assert.deepEqual(q.calls[0]!.params, ['fan-sub-1', TICKET]);
      assert.match(q.calls[0]!.sql, /WHERE o\.fan_id = \$1 AND o\.status = 'confirmed' AND o\.id = \$2$/);
    } finally {
      q.restore();
    }
  });

  test('GET /api/me/tickets/:ticketId: 404 not_found when no row comes back', async () => {
    const q = fakeQuery([]);
    try {
      assert.deepEqual(await get(`/api/me/tickets/${TICKET}`, fan()), {
        status: 404,
        cacheControl: 'no-store',
        body: { error: { code: 'not_found', message: 'Ticket not found' } },
      });
    } finally {
      q.restore();
    }
  });

  test('presignTicketDownload: a 5-minute signed GET of tickets/<orderId>.pdf, downloaded as an attachment', async () => {
    assert.equal(account.ticketPdfKey(TICKET), `tickets/${TICKET}.pdf`);

    const { url, expiresInSeconds } = await account.presignTicketDownload('tm-test-tickets', TICKET);
    assert.equal(expiresInSeconds, 300);
    const link = new URL(url);
    assert.equal(link.origin, 'https://tm-test-tickets.s3.ap-southeast-1.amazonaws.com');
    assert.equal(link.pathname, `/tickets/${TICKET}.pdf`);
    const q = link.searchParams;
    assert.equal(q.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(q.get('X-Amz-Expires'), '300');
    assert.match(q.get('X-Amz-Credential')!, /^AKIATESTONLY0000\/\d{8}\/ap-southeast-1\/s3\/aws4_request$/);
    assert.equal(q.get('X-Amz-SignedHeaders'), 'host');
    assert.match(q.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
    assert.equal(q.get('response-content-disposition'), `attachment; filename="ticketmastery-${TICKET}.pdf"`);
  });
});
