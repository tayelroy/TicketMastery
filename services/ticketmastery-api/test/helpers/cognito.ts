/**
 * Test doubles for AUTH_MODE=cognito: a throwaway RSA key that signs Cognito-shaped tokens, and a fake JWKS
 * endpoint. Nothing here talks to the network or to real Cognito.
 *
 * aws-jwt-verify fetches the JWKS with `https.request` (looked up on the module at call time), so replacing that
 * one function is enough to serve, withhold or fail the keys while the library still runs every real check.
 */
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';

export const POOL_ID = 'ap-southeast-1_TestPool1';
export const CLIENT_ID = 'test-client-id-123';
export const ISSUER = `https://cognito-idp.ap-southeast-1.amazonaws.com/${POOL_ID}`;
export const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;
/** Cognito's newer global issuer format; aws-jwt-verify accepts (and hydrates) both. */
export const GLOBAL_ISSUER = `https://issuer-cognito-idp.ap-southeast-1.amazonaws.com/${POOL_ID}`;
export const GLOBAL_JWKS_URI = `${GLOBAL_ISSUER}/.well-known/jwks.json`;
export const KID = 'test-key-1';

/** Environment for importing src/ in cognito mode without a database or a real pool. */
export const cognitoEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DB_HOST: 'unused',
  DB_NAME: 'unused',
  DB_USER: 'unused',
  DB_PASSWORD: 'unused',
  AUTH_MODE: 'cognito',
  COGNITO_USER_POOL_ID: POOL_ID,
  COGNITO_CLIENT_ID: CLIENT_ID,
};

/** A type alias, not an interface, so it is assignable to aws-jwt-verify's `Jwk` (a JSON object). */
export type TestJwk = {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
};

export interface SigningKey {
  privateKey: KeyObject;
  jwk: TestJwk;
}

/** A fresh RSA key pair; `jwk` is the public half as Cognito publishes it. */
export function newSigningKey(kid = KID): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { kty: 'RSA', n: n!, e: e!, kid, alg: 'RS256', use: 'sig' } };
}

/** The key the fake user pool signs with (and publishes in its JWKS). */
export const poolKey = newSigningKey();

export const b64url = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');

export interface TokenOptions {
  /** Replaces or adds payload claims. */
  claims?: Record<string, unknown>;
  /** Replaces or adds header fields (e.g. `kid`, `alg`). */
  header?: Record<string, unknown>;
  /** Defaults to the pool's key. */
  key?: SigningKey;
}

/** A Cognito-shaped access token (as issued to the SPA app client), RS256-signed. */
export function makeToken({ claims = {}, header = {}, key = poolKey }: TokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = b64url({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT', ...header });
  const encodedPayload = b64url({
    sub: 'fan-sub-1',
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    scope: 'aws.cognito.signin.user.admin',
    auth_time: now,
    iat: now,
    exp: now + 3600,
    jti: 'jti-1',
    username: 'fan-sub-1',
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), key.privateKey);
  return `${encodedHeader}.${encodedPayload}.${b64url(signature)}`;
}

export type JwksBehaviour = { keys: TestJwk[] } | 'unreachable' | { status: number };

/**
 * Fake JWKS endpoint. `install()` replaces `https.request`; every request is recorded in `requests` and answered
 * from `behaviour` (default: unreachable, so an unexpected fetch fails loudly instead of reaching the internet).
 */
export class FakeJwksEndpoint {
  readonly requests: string[] = [];
  behaviour: JwksBehaviour = 'unreachable';
  private original: typeof https.request | undefined;

  install(): void {
    this.original = https.request;
    https.request = ((uri: string | URL, _options: unknown, onResponse: (res: Readable) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end: () => setImmediate(() => this.answer(req, onResponse)),
        destroy: () => undefined,
      });
      this.requests.push(String(uri));
      return req;
    }) as unknown as typeof https.request;
  }

  restore(): void {
    if (this.original) https.request = this.original;
  }

  /**
   * Requested URIs, sorted (regional `cognito-idp` before global `issuer-cognito-idp`), after letting in-flight
   * requests and retries finish.
   */
  async settledRequests(): Promise<string[]> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return [...this.requests].sort();
  }

  private answer(req: EventEmitter, onResponse: (res: Readable) => void): void {
    const behaviour = this.behaviour;
    if (behaviour === 'unreachable') {
      req.emit('error', new Error('getaddrinfo ENOTFOUND cognito-idp.ap-southeast-1.amazonaws.com'));
    } else if ('status' in behaviour) {
      onResponse(Object.assign(Readable.from([]), { statusCode: behaviour.status }));
    } else {
      const body = Buffer.from(JSON.stringify({ keys: behaviour.keys }));
      onResponse(Object.assign(Readable.from([body]), { statusCode: 200 }));
    }
  }
}
