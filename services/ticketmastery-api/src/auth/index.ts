import type { RequestHandler } from 'express';
import { config } from '../config';
import { HttpError } from '../http/errors';

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
 * Populates req.user. Does not reject anonymous requests by itself (chain requireGroup for that),
 * so public routes (UC1 discovery) can still see an optional user.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  if (config.AUTH_MODE === 'dev-header') {
    // DEV STUB — replace with Cognito JWT verification (Andrew)
    // Any caller can claim any identity with these headers. Only acceptable locally, or behind
    // ALLOW_DEV_AUTH=true until Cognito is wired up.
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

  // AUTH_MODE=cognito
  // TODO(Andrew): verify the Cognito access/ID token (aws-jwt-verify against COGNITO_USER_POOL_ID /
  // COGNITO_CLIENT_ID), or read claims forwarded by the API Gateway Cognito authorizer once the
  // X-Origin-Verify check guarantees requests came through API Gateway. Map `sub` and `cognito:groups`.
  next(new HttpError(501, 'auth_not_implemented', 'cognito auth not implemented yet'));
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
