import { createApp } from './app';
import { hydrateAuth } from './auth';
import { config, devAuthInProduction } from './config';
import { runMigrations } from './db/migrate';
import { pool } from './db/pool';
import { logger } from './logger';
import { appVersion } from './version';

async function main() {
  if (devAuthInProduction) {
    logger.warn(
      '!!!!! AUTH_MODE=dev-header IN PRODUCTION (ALLOW_DEV_AUTH=true): any caller can impersonate any user ' +
        'or organiser via x-dev-user-* headers. Switch to AUTH_MODE=cognito as soon as Cognito is ready. !!!!!',
    );
  }

  if (config.RUN_MIGRATIONS_ON_START) {
    // Safe with several tasks starting at once: runMigrations serialises on a Postgres advisory lock.
    const result = await runMigrations();
    logger.info(result, 'migrations complete');
  }

  // AUTH_MODE=cognito: load the signing keys before taking traffic; if Cognito is unreachable (no egress), fail
  // fast so ECS restarts the task instead of serving 401s. No-op in dev-header mode.
  await hydrateAuth();

  const server = createApp().listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, authMode: config.AUTH_MODE, version: appVersion },
      'ticketmastery-api listening',
    );
  });
  // Must exceed the ALB idle timeout (60s) or the ALB occasionally gets a closed socket -> 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // ECS sends SIGTERM, waits stopTimeout (default 30s), then SIGKILL.
    logger.info({ signal }, 'shutting down');
    server.close((err) => {
      if (err) logger.error({ err }, 'error closing http server');
      pool
        .end()
        .catch((poolErr: unknown) => logger.error({ err: poolErr }, 'error closing pg pool'))
        .finally(() => process.exit(err ? 1 : 0));
    });
    server.closeIdleConnections();
    setTimeout(() => {
      logger.error('forced exit after shutdown timeout');
      process.exit(1);
    }, 25_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
