import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

/** Anything that can run a query: the shared pool or a checked-out client inside a transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

export const pool = new Pool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  max: config.DB_POOL_MAX,
  // TLS is encrypted but the server certificate is not verified. To verify, bundle the
  // RDS CA (https://truststore.pki.rds.amazonaws.com/ap-southeast-1/ap-southeast-1-bundle.pem)
  // into the image and use { ca: fs.readFileSync(path), rejectUnauthorized: true }.
  ssl: config.DB_SSL ? { rejectUnauthorized: false } : false,
  // Fail fast instead of queueing forever when the pool is exhausted or RDS is unreachable.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: 'ticketmastery-api',
});

// An idle client erroring (e.g. RDS failover/restart) must not crash the process.
pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

export async function query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<R>(text, params);
}

/**
 * Runs `fn` inside BEGIN/COMMIT on a dedicated client; rolls back on any thrown error
 * and always releases the client. Default isolation is READ COMMITTED.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Connection is unusable; destroy it rather than returning it to the pool.
      broken = true;
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
