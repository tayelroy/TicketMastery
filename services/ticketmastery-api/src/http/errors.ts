import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { DatabaseError } from 'pg';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Express 4 does not forward rejected promises to the error handler; wrap async handlers with this. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Postgres SQLSTATE -> HTTP mapping for constraint and trigger failures that reach the handler. */
const PG_ERROR_MAP: Record<string, { status: number; code: string }> = {
  '23505': { status: 409, code: 'unique_violation' },
  '23514': { status: 400, code: 'check_violation' },
  '23503': { status: 409, code: 'foreign_key_violation' },
  '23502': { status: 400, code: 'not_null_violation' },
  '22P02': { status: 400, code: 'invalid_input' },
  // RAISE EXCEPTION in our triggers (layout lock, concert status guards).
  P0001: { status: 409, code: 'conflict' },
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof DatabaseError && err.code && PG_ERROR_MAP[err.code]) {
    const mapped = PG_ERROR_MAP[err.code]!;
    req.log.warn({ pgCode: err.code, constraint: err.constraint, detail: err.detail }, err.message);
    res.status(mapped.status).json({
      error: { code: mapped.code, message: err.message, details: { constraint: err.constraint } },
    });
    return;
  }
  // body-parser errors (malformed JSON, payload too large) carry `type: 'entity.*'` and an HTTP status.
  if (
    err instanceof Error &&
    'type' in err &&
    typeof err.type === 'string' &&
    err.type.startsWith('entity.') &&
    'status' in err &&
    typeof err.status === 'number'
  ) {
    res.status(err.status).json({ error: { code: err.type, message: err.message } });
    return;
  }

  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
};
