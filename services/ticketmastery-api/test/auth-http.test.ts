/**
 * End-to-end through Express in AUTH_MODE=cognito, no database: the real createApp() on an ephemeral port, real
 * routers and error handler, tokens from the throwaway pool key. Checks the JSON a client actually receives.
 * Routes are UC5's (`authenticate` + `requireGroup('organisers')`), the strictest guard in the API today.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { cognitoEnv, FakeJwksEndpoint, makeToken, poolKey } from './helpers/cognito';

describe('HTTP API with AUTH_MODE=cognito', () => {
  let server: Server;
  let baseUrl: string;
  const jwks = new FakeJwksEndpoint(); // unreachable: every key must come from the cache below

  before(async () => {
    Object.assign(process.env, cognitoEnv);
    jwks.install();
    const { cognitoVerifier } = await import('../src/auth/index.js');
    cognitoVerifier!.cacheJwks({ keys: [poolKey.jwk] });
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    jwks.restore();
  });

  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } };
  }

  const fan = () => ({ Authorization: `Bearer ${makeToken()}` });
  const organiser = () => ({ Authorization: `Bearer ${makeToken({ claims: { 'cognito:groups': ['organisers'] } })}` });

  test('no token: 401 unauthenticated', async () => {
    assert.deepEqual(await call('GET', '/api/organiser/concerts'), {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'Authentication required' } },
    });
  });

  test('dev headers alone are not an identity: 401 unauthenticated', async () => {
    const res = await call('GET', '/api/organiser/concerts', {
      'x-dev-user-id': 'org-1',
      'x-dev-user-groups': 'organisers',
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error?.code, 'unauthenticated');
  });

  test('a bad token: 401 invalid_token, even where the route would need more than sign-in', async () => {
    for (const headers of [{ Authorization: 'Bearer junk' }, { Authorization: 'Basic abc' }]) {
      const res = await call('GET', '/api/organiser/concerts', headers);
      assert.equal(res.status, 401, headers.Authorization);
      assert.equal(res.body.error?.code, 'invalid_token');
    }
  });

  test('a fan token on an organiser route: 403 forbidden', async () => {
    assert.deepEqual(await call('GET', '/api/organiser/concerts', fan()), {
      status: 403,
      body: { error: { code: 'forbidden', message: "Requires membership of group 'organisers'" } },
    });
  });

  test('an organiser token reaches the handler (validation runs before any DB access)', async () => {
    const res = await call('POST', '/api/organiser/concerts', organiser(), {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'validation_error');
  });
});
