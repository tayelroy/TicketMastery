import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { RequestHandler } from 'express';
import { config } from '../config';
import { HttpError } from '../http/errors';
import { logger } from '../logger';

export interface AuthUser {
  /** Cognito `sub` (stable user id). */
  sub: string;
  /** Cognito groups, e.g. ['organisers']. */
  groups: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const ORGANISERS_GROUP = 'organisers';

/**
 * Verifies Cognito ACCESS tokens (AUTH_MODE=cognito): RS256 signature against the user pool's JWKS, issuer,
 * expiry, `token_use = access` and `client_id`. Created once so its in-memory JWKS cache is shared by every
 * request; keys are re-fetched only when Cognito rotates them (unknown `kid`). Null in dev-header mode.
 * config.ts refuses to start in cognito mode unless both IDs are set, hence the non-null assertions.
 */
export const cognitoVerifier =
  config.AUTH_MODE === 'cognito'
    ? CognitoJwtVerifier.create({
        userPoolId: config.COGNITO_USER_POOL_ID!,
        clientId: config.COGNITO_CLIENT_ID!,
        tokenUse: 'access',
      })
    : null;

/**
 * Fetches Cognito's signing keys before the server takes traffic, so the first request doesn't pay for it.
 * Rejects if Cognito is unreachable (server.ts then exits and ECS restarts the task). No-op in dev-header mode.
 */
export async function hydrateAuth(): Promise<void> {
  if (!cognitoVerifier) return;
  await cognitoVerifier.hydrate();
  logger.info('cognito signing keys loaded');
}

/** `Bearer <token>` (scheme case-insensitive) -> token; anything else -> undefined. */
function bearerToken(header: string): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
}

/**
 * Populates req.user. Does not reject anonymous requests by itself (chain requireUser / requireGroup for that),
 * so public routes (UC1 discovery) can still see an optional user. A token that is present but invalid is a 401.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  if (config.AUTH_MODE === 'dev-header') {
    // DEV ONLY: any caller can claim any identity with these headers. Acceptable locally, or behind
    // ALLOW_DEV_AUTH=true until AUTH_MODE=cognito is deployed.
    const sub = req.header('x-dev-user-id')?.trim();
    if (sub) {
      const groups = (req.header('x-dev-user-groups') ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      req.user = { sub, groups };
    }
    next();
    return;
  }

  // AUTH_MODE=cognito. API Gateway's JWT authorizer already checked protected routes; this second check is the
  // zero-trust layer (it also covers local runs and anything that reaches the API without the gateway).
  // x-dev-user-* headers are ignored in this mode.
  const header = req.header('authorization');
  if (!header) {
    next(); // anonymous: requireUser / requireGroup decide
    return;
  }
  const token = bearerToken(header);
  if (!token) {
    next(new HttpError(401, 'invalid_token', 'Authorization header must be "Bearer <access token>"'));
    return;
  }
  cognitoVerifier!
    .verify(token)
    .then((claims) => {
      req.user = { sub: claims.sub, groups: claims['cognito:groups'] ?? [] };
      next();
    })
    .catch((err: unknown) => {
      req.log.debug({ err }, 'rejected access token');
      next(new HttpError(401, 'invalid_token', 'Invalid or expired token'));
    });
};

/** 401 if anonymous. Use on routes any signed-in user may call (/api/me, /api/checkout). */
export const requireUser: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new HttpError(401, 'unauthenticated', 'Authentication required'));
};

/** 401 if anonymous, 403 if the user is not in `group`. */
export const requireGroup =
  (group: string): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) {
      next(new HttpError(401, 'unauthenticated', 'Authentication required'));
    } else if (!req.user.groups.includes(group)) {
      next(new HttpError(403, 'forbidden', `Requires membership of group '${group}'`));
    } else {
      next();
    }
  };
