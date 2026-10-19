import { Router } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from './db/pool';
import { appVersion } from './version';

const DB_CHECK_TIMEOUT_MS = 2_000;

/**
 * Mounted at the root (not /api).
 * - GET /health       readiness: ALB target-group health check; pings the DB.
 * - GET /health/live  liveness: process is up (container HEALTHCHECK); never touches the DB, so a DB
 *                     outage does not make ECS kill every task.
 */
export const healthRouter = Router();

healthRouter.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const uptimeSeconds = Math.round(process.uptime());
  // Bounds both waiting for a pool connection and the query itself.
  const timer = new AbortController();
  const timeout = sleep(DB_CHECK_TIMEOUT_MS, undefined, { signal: timer.signal }).then(
    () => {
      throw new Error(`db ping timed out after ${DB_CHECK_TIMEOUT_MS}ms`);
    },
    () => undefined, // aborted because the ping already settled
  );
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
    res.json({ status: 'ok', db: 'ok', uptimeSeconds, version: appVersion });
  } catch (err) {
    req.log.warn({ err }, 'health check: database unavailable');
    res.status(503).json({ status: 'error', db: 'down', uptimeSeconds, version: appVersion });
  } finally {
    timer.abort();
  }
});

healthRouter.get('/health/live', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), version: appVersion });
});
