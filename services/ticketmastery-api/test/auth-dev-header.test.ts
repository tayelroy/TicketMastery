/**
 * Unit tests for AUTH_MODE=dev-header (the local default) in src/auth. Runs in its own process (one per test
 * file), so the mode is fixed before src/ is imported. Guards that PR 2's Cognito work leaves teammates' local
 * flow unchanged: x-dev-user-* headers set req.user, Authorization headers are not checked, nothing is fetched.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import type * as AuthModule from '../src/auth';
import { FakeJwksEndpoint } from './helpers/cognito';

describe('src/auth with AUTH_MODE=dev-header', () => {
  let auth: typeof AuthModule;
  const jwks = new FakeJwksEndpoint();

  before(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DB_HOST: 'unused',
      DB_NAME: 'unused',
      DB_USER: 'unused',
      DB_PASSWORD: 'unused',
      AUTH_MODE: 'dev-header',
    });
    jwks.install();
    auth = await import('../src/auth/index.js');
  });

  after(() => jwks.restore());

  function run(req: Partial<Request>) {
    return new Promise<unknown>((resolve) =>
      auth.authenticate(req as Request, {} as Response, resolve as NextFunction),
    );
  }

  function fakeReq(headers: Record<string, string>): Partial<Request> {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { header: ((name: string) => lower[name.toLowerCase()]) as Request['header'] };
  }

  test('no Cognito verifier is created and hydrateAuth is a no-op (no JWKS fetch)', async () => {
    assert.equal(auth.cognitoVerifier, null);
    assert.equal(await auth.hydrateAuth(), undefined);
    assert.deepEqual(await jwks.settledRequests(), []);
  });

  test('x-dev-user-id and x-dev-user-groups set req.user (trimmed, blanks dropped)', async () => {
    const req = fakeReq({ 'x-dev-user-id': '  org-1 ', 'x-dev-user-groups': ' organisers, ,fans,' });
    assert.equal(await run(req), undefined);
    assert.deepEqual(req.user, { sub: 'org-1', groups: ['organisers', 'fans'] });
  });

  test('an id without a groups header gives no groups', async () => {
    const req = fakeReq({ 'x-dev-user-id': 'fan-1' });
    assert.equal(await run(req), undefined);
    assert.deepEqual(req.user, { sub: 'fan-1', groups: [] });
  });

  test('no id, or a blank one, is anonymous even with groups', async () => {
    const anonymous: Array<Record<string, string>> = [
      {},
      { 'x-dev-user-id': '   ', 'x-dev-user-groups': 'organisers' },
    ];
    for (const headers of anonymous) {
      const req = fakeReq(headers);
      assert.equal(await run(req), undefined);
      assert.equal(req.user, undefined);
    }
  });

  test('Authorization headers are not checked in this mode (no 401 for a junk token)', async () => {
    const req = fakeReq({ Authorization: 'Bearer junk' });
    assert.equal(await run(req), undefined);
    assert.equal(req.user, undefined);
  });
});
