import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import { config } from './config';
import { healthRouter } from './health';
import { errorHandler, notFoundHandler } from './http/errors';
import { logger } from './logger';
import { modules } from './modules';
import type { ModuleKey } from './modules/keys';

/** Mounts the health routes and the feature modules in `apiModules` (default: API_MODULES); others answer 404. */
export function createApp(apiModules: readonly ModuleKey[] = config.API_MODULES): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // The ALB polls /health every few seconds; keep those out of the logs.
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  // Layout payloads can be large (thousands of explicit seat numbers).
  app.use(express.json({ limit: '2mb' }));

  // Health stays at the root for the ALB target group; feature APIs live under /api. Every service mounts health,
  // whichever modules it serves.
  app.use(healthRouter);
  for (const m of modules) {
    if (apiModules.includes(m.key)) app.use(`/api${m.basePath}`, m.router);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
