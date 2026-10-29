/**
 * Unit tests for AUTH_MODE=cognito in src/auth: no network, no database, no real Cognito.
 * Tokens are signed with a throwaway RSA key whose public JWK is served by a fake JWKS endpoint (or loaded into
 * the verifier's cache), so aws-jwt-verify runs its real checks: signature, algorithm, kid, issuer, expiry,
 * token_use and client_id.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import type * as AuthModule from '../src/auth';
import type * as ErrorsModule from '../src/http/errors';
import type * as LoggerModule from '../src/logger';
import {
  b64url,
  cognitoEnv,
  FakeJwksEndpoint,
  GLOBAL_ISSUER,
  GLOBAL_JWKS_URI,
  ISSUER,
  JWKS_URI,
  KID,
  makeToken,
  newSigningKey,
  poolKey,
} from './helpers/cognito';

describe('src/auth with AUTH_MODE=cognito', () => {
  let auth: typeof AuthModule;
  let errors: typeof ErrorsModule;
  let logger: typeof LoggerModule.logger;
  const jwks = new FakeJwksEndpoint();

  before(async () => {
    // config.ts validates the environment when first imported, so set it before the dynamic import.
    Object.assign(process.env, cognitoEnv);
    auth = await import('../src/auth/index.js');
    errors = await import('../src/http/errors.js');
    ({ logger } = await import('../src/logger.js'));
    jwks.install();
  });

  after(() => jwks.restore());

  beforeEach(() => {
    jwks.requests.length = 0;
    jwks.behaviour = 'unreachable';
  });

  /** Runs one middleware and resolves with whatever it passed to next(). */
  function run(mw: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>) {
    return new Promise<unknown>((resolve) => mw(req as Request, {} as Response, resolve));
  }

  interface FakeReq extends Partial<Request> {
    debugLogs: Array<{ obj: unknown; msg: unknown }>;
  }

  function fakeReq(headers: Record<string, string>): FakeReq {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const debugLogs: FakeReq['debugLogs'] = [];
    return {
      debugLogs,
      header: ((name: string) => lower[name.toLowerCase()]) as Request['header'],
      log: { debug: (obj: unknown, msg: unknown) => debugLogs.push({ obj, msg }) } as unknown as Request['log'],
    };
  }

  function assertHttpError(err: unknown, status: number, code: string, message?: string) {
    assert.ok(err instanceof errors.HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, message);
  }

  /** Runs authenticate and asserts it rejected with 401 invalid_token, logged why, and left req.user unset. */
  async function assertRejected(headers: Record<string, string>) {
    const req = fakeReq(headers);
    assertHttpError(await run(auth.authenticate, req), 401, 'invalid_token', 'Invalid or expired token');
    assert.equal(req.user, undefined);
    assert.equal(req.debugLogs.length, 1);
    assert.equal(req.debugLogs[0]!.msg, 'rejected access token');
    assert.ok((req.debugLogs[0]!.obj as { err: unknown }).err instanceof Error);
  }

  describe('hydrateAuth', () => {
    test('rejects when Cognito is unreachable, so server.ts fails fast', async () => {
      const info = mock.method(logger, 'info');
      try {
        await assert.rejects(auth.hydrateAuth(), /ENOTFOUND/);
        assert.equal(info.mock.callCount(), 0, 'must not claim the keys are loaded');
      } finally {
        info.mock.restore();
      }
      // Both issuer formats, each tried twice (aws-jwt-verify retries network errors once).
      assert.deepEqual(await jwks.settledRequests(), [JWKS_URI, JWKS_URI, GLOBAL_JWKS_URI, GLOBAL_JWKS_URI]);
    });

    test('rejects when the JWKS endpoint answers with an error status (no retry)', async () => {
      jwks.behaviour = { status: 404 };
      await assert.rejects(auth.hydrateAuth(), /Status code is 404/);
      assert.deepEqual(await jwks.settledRequests(), [JWKS_URI, GLOBAL_JWKS_URI]);
    });

    test("fetches the user pool's JWKS, logs, and later verifications use the cache", async () => {
      jwks.behaviour = { keys: [poolKey.jwk] };
      const info = mock.method(logger, 'info');
      try {
        await auth.hydrateAuth();
        assert.deepEqual(
          info.mock.calls.map((c) => c.arguments),
          [['cognito signing keys loaded']],
        );
      } finally {
        info.mock.restore();
      }
      assert.deepEqual(await jwks.settledRequests(), [JWKS_URI, GLOBAL_JWKS_URI]);

      jwks.behaviour = 'unreachable';
      const req = fakeReq({ Authorization: `Bearer ${makeToken()}` });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'fan-sub-1', groups: [] });
      assert.equal(jwks.requests.length, 2, 'no extra JWKS fetch for a cached kid');
    });
  });

  describe('authenticate', () => {
    before(() => auth.cognitoVerifier!.cacheJwks({ keys: [poolKey.jwk] }));

    test('the verifier is created for access tokens of this pool and client', () => {
      assert.ok(auth.cognitoVerifier);
    });

    test('valid access token sets req.user with sub and every group, in order', async () => {
      const token = makeToken({ claims: { sub: 'org-sub-9', 'cognito:groups': ['organisers', 'beta'] } });
      const req = fakeReq({ Authorization: `Bearer ${token}` });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'org-sub-9', groups: ['organisers', 'beta'] });
      assert.equal(req.debugLogs.length, 0);
    });

    test('token without cognito:groups gives an empty group list', async () => {
      const req = fakeReq({ Authorization: `Bearer ${makeToken()}` });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'fan-sub-1', groups: [] });
    });

    test("accepts Cognito's global issuer format for the same pool", async () => {
      const req = fakeReq({ Authorization: `Bearer ${makeToken({ claims: { iss: GLOBAL_ISSUER } })}` });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'fan-sub-1', groups: [] });
    });

    test('scheme is case-insensitive and surrounding whitespace is ignored', async () => {
      for (const header of [`bearer ${makeToken()}`, `BEARER ${makeToken()}`, `  Bearer \t ${makeToken()}  `]) {
        const req = fakeReq({ Authorization: header });
        assert.equal(await run(auth.authenticate, req), undefined, header);
        assert.equal(req.user?.sub, 'fan-sub-1');
      }
    });

    test('no (or an empty) Authorization header leaves the request anonymous', async () => {
      const anonymous: Array<Record<string, string>> = [{}, { Authorization: '' }];
      for (const headers of anonymous) {
        const req = fakeReq(headers);
        assert.equal(await run(auth.authenticate, req), undefined);
        assert.equal(req.user, undefined);
      }
    });

    test('x-dev-user-* headers are ignored in cognito mode', async () => {
      const req = fakeReq({ 'x-dev-user-id': 'evil', 'x-dev-user-groups': 'organisers' });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.equal(req.user, undefined);
    });

    test('x-dev-user-* headers cannot override the identity in a valid token', async () => {
      const req = fakeReq({
        Authorization: `Bearer ${makeToken()}`,
        'x-dev-user-id': 'evil',
        'x-dev-user-groups': 'organisers',
      });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'fan-sub-1', groups: [] });
    });

    const malformedHeaders = ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer   ', `Bearer ${makeToken()} extra`, makeToken()];
    for (const header of malformedHeaders) {
      test(`401 invalid_token without calling the verifier for header ${JSON.stringify(header.slice(0, 20))}`, async () => {
        const req = fakeReq({ Authorization: header });
        assertHttpError(
          await run(auth.authenticate, req),
          401,
          'invalid_token',
          'Authorization header must be "Bearer <access token>"',
        );
        assert.equal(req.user, undefined);
        assert.equal(req.debugLogs.length, 0);
      });
    }

    const now = () => Math.floor(Date.now() / 1000);
    const otherKey = newSigningKey(KID); // same kid as the pool's key, different key material
    const rejected: Array<[string, () => string]> = [
      ['not a JWT', () => 'not.a.jwt'],
      ['signed with another key under the same kid', () => makeToken({ key: otherKey })],
      [
        'payload changed after signing',
        () => {
          const [header, payload, signature] = makeToken().split('.');
          const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>;
          return `${header}.${b64url({ ...claims, sub: 'someone-else' })}.${signature}`;
        },
      ],
      [
        'alg none with no signature',
        () => `${b64url({ alg: 'none', kid: KID, typ: 'JWT' })}.${makeToken().split('.')[1]}.`,
      ],
      ['HS256 (algorithm confusion)', () => makeToken({ header: { alg: 'HS256' } })],
      ['no kid', () => makeToken({ header: { kid: undefined } })],
      ['expired', () => makeToken({ claims: { exp: now() - 60 } })],
      ['another app client', () => makeToken({ claims: { client_id: 'other-client' } })],
      ['ID token instead of access token', () => makeToken({ claims: { token_use: 'id', aud: 'test-client-id-123' } })],
      ['no token_use', () => makeToken({ claims: { token_use: undefined } })],
      ['another user pool', () => makeToken({ claims: { iss: `${ISSUER}x` } })],
      ['no issuer', () => makeToken({ claims: { iss: undefined } })],
    ];
    for (const [name, token] of rejected) {
      test(`401 invalid_token: ${name}`, async () => {
        await assertRejected({ Authorization: `Bearer ${token()}` });
      });
    }

    test('unknown kid re-fetches the JWKS (key rotation) and accepts a token signed with the new key', async () => {
      const rotated = newSigningKey('rotated-key');
      jwks.behaviour = { keys: [poolKey.jwk, rotated.jwk] };
      const req = fakeReq({ Authorization: `Bearer ${makeToken({ key: rotated })}` });
      assert.equal(await run(auth.authenticate, req), undefined);
      assert.deepEqual(req.user, { sub: 'fan-sub-1', groups: [] });
      assert.deepEqual(jwks.requests, [JWKS_URI]);
    });

    test('unknown kid while Cognito is unreachable is a 401, not a crash or a hang', async () => {
      await assertRejected({ Authorization: `Bearer ${makeToken({ key: newSigningKey('offline-key') })}` });
      assert.deepEqual(jwks.requests, [JWKS_URI, JWKS_URI]);
    });

    // Last on purpose: a kid that stays unknown puts the JWKS URI in aws-jwt-verify's penalty box (anti-flooding),
    // so later unknown kids are refused without a fetch for a while.
    test('unknown kid that is not in the fresh JWKS either is a 401', async () => {
      jwks.behaviour = { keys: [poolKey.jwk] };
      await assertRejected({ Authorization: `Bearer ${makeToken({ key: newSigningKey('forged-key') })}` });
      assert.deepEqual(jwks.requests, [JWKS_URI]);
    });
  });

  describe('requireUser', () => {
    test('401 unauthenticated when anonymous', async () => {
      assertHttpError(await run(auth.requireUser, {}), 401, 'unauthenticated', 'Authentication required');
    });

    test('passes any signed-in user, with or without groups', async () => {
      assert.equal(await run(auth.requireUser, { user: { sub: 's', groups: [] } }), undefined);
      assert.equal(await run(auth.requireUser, { user: { sub: 's', groups: ['organisers'] } }), undefined);
    });
  });

  describe('requireGroup', () => {
    const mw = () => auth.requireGroup(auth.ORGANISERS_GROUP);

    test("the organiser group is called 'organisers' (Cognito group name in infra)", () => {
      assert.equal(auth.ORGANISERS_GROUP, 'organisers');
    });

    test('401 unauthenticated when anonymous', async () => {
      assertHttpError(await run(mw(), {}), 401, 'unauthenticated', 'Authentication required');
    });

    test('403 forbidden for a user outside the group, naming the group', async () => {
      assertHttpError(
        await run(mw(), { user: { sub: 's', groups: ['fans'] } }),
        403,
        'forbidden',
        "Requires membership of group 'organisers'",
      );
    });

    test('passes a member of the group among others', async () => {
      assert.equal(await run(mw(), { user: { sub: 's', groups: ['fans', 'organisers'] } }), undefined);
    });
  });
});
