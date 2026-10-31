/**
 * UC2 /api/me through Express in AUTH_MODE=cognito, no database: the real createApp() on an ephemeral port, tokens
 * from the throwaway pool key. Covers everything decided before any SQL runs (sign-in, the ticket id, a missing PDF
 * bucket) and signs a download link offline. Orders themselves are in account.test.ts (Postgres).
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type * as AccountServiceModule from '../src/modules/account/service';
import { cognitoEnv, FakeJwksEndpoint, makeToken, poolKey } from './helpers/cognito';

const TICKET = '3b0c7f1e-6f43-4c1a-9d43-8a6f1c2b5e10';

describe('UC2 /api/me over HTTP (AUTH_MODE=cognito, no database)', () => {
  let server: Server;
  let baseUrl: string;
  let account: typeof AccountServiceModule;
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
