/**
 * UC2 e-ticket download with TICKET_PDF_BUCKET set, no database and no AWS: pool.query answers with canned rows and
 * S3Client.send is replaced, so this covers the PDF check before signing. Its own file because the service reads the
 * bucket name once, when it is first imported (account-http.test.ts runs without one).
 */
import { HeadObjectCommand, NotFound, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, mock, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import { cognitoEnv, FakeJwksEndpoint, makeToken, poolKey } from './helpers/cognito';

const TICKET = '3b0c7f1e-6f43-4c1a-9d43-8a6f1c2b5e10';
const BUCKET = 'tm-test-tickets';

describe('UC2 e-ticket download (TICKET_PDF_BUCKET set, S3 and Postgres replaced)', () => {
  let server: Server;
  let baseUrl: string;
  let db: typeof PoolModule;
  const jwks = new FakeJwksEndpoint();

  before(async () => {
    Object.assign(process.env, cognitoEnv, {
      TICKET_PDF_BUCKET: BUCKET,
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTONLY0000',
      AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
    });
    delete process.env.AWS_PROFILE; // with it set, the SDK skips the key variables above
    delete process.env.AWS_SESSION_TOKEN;
    jwks.install();
    const { cognitoVerifier } = await import('../src/auth/index.js');
    cognitoVerifier!.cacheJwks({ keys: [poolKey.jwk] });
    db = await import('../src/db/pool.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    jwks.restore();
  });

  /**
   * Runs one download with the order found (or not) and S3's HeadObject answering `head`. Returns the response and
   * every command sent to S3; both fakes are restored afterwards.
   */
  async function download(orderFound: boolean, head: () => Promise<unknown>) {
    const sent: unknown[] = [];
    const query = mock.method(db.pool, 'query', async () => ({ rows: orderFound ? [{ id: TICKET }] : [] }));
    const send = mock.method(S3Client.prototype, 'send', async (command: unknown) => {
      sent.push(command);
      return head();
    });
    try {
      const res = await fetch(`${baseUrl}/api/me/tickets/${TICKET}/download`, {
        headers: { Authorization: `Bearer ${makeToken()}` },
      });
      return { status: res.status, body: (await res.json()) as any, sent, queryParams: query.mock.calls[0]?.arguments };
    } finally {
      query.mock.restore();
      send.mock.restore();
    }
  }

  test('PDF written: checks tickets/<orderId>.pdf with HeadObject, then returns the signed link', async () => {
    const res = await download(true, async () => ({}));
    assert.equal(res.status, 200);
    assert.deepEqual(res.queryParams?.[1], ['fan-sub-1', TICKET]);
    assert.equal(res.sent.length, 1);
    assert.ok(res.sent[0] instanceof HeadObjectCommand);
    assert.deepEqual(res.sent[0].input, { Bucket: BUCKET, Key: `tickets/${TICKET}.pdf` });
    assert.equal(res.body.expiresInSeconds, 300);
    const link = new URL(res.body.url);
    assert.equal(link.origin, `https://${BUCKET}.s3.ap-southeast-1.amazonaws.com`);
    assert.equal(link.pathname, `/tickets/${TICKET}.pdf`);
  });

  test('PDF not written yet (S3 404): 409 ticket_not_ready, so the page can say so', async () => {
    const res = await download(true, async () => {
      throw new NotFound({ message: 'NotFound', $metadata: { httpStatusCode: 404 } });
    });
    assert.deepEqual(
      { status: res.status, body: res.body },
      { status: 409, body: { error: { code: 'ticket_not_ready', message: 'Your e-ticket is still being prepared' } } },
    );
  });

  test('any other S3 failure (e.g. 403 without s3:ListBucket): 500, not a broken link', async () => {
    const res = await download(true, async () => {
      throw new S3ServiceException({
        name: 'Forbidden',
        $fault: 'client',
        message: 'Forbidden',
        $metadata: { httpStatusCode: 403 },
      });
    });
    assert.deepEqual(
      { status: res.status, body: res.body },
      { status: 500, body: { error: { code: 'internal_error', message: 'Internal server error' } } },
    );
  });

  test("someone else's or unknown order: 404 before S3 is asked anything", async () => {
    const res = await download(false, async () => ({}));
    assert.deepEqual(
      { status: res.status, body: res.body },
      { status: 404, body: { error: { code: 'not_found', message: 'Ticket not found' } } },
    );
    assert.equal(res.sent.length, 0);
  });
});
