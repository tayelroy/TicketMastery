import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../logger';
import { pool as sharedPool } from './pool';

/** Same path from src/db (tsx) and dist/db (compiled); the Dockerfile copies migrations/ next to dist/. */
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Arbitrary constant for pg_advisory_lock so concurrent ECS tasks (or a task plus a
 * manual `npm run migrate`) serialise instead of racing. Do not change it.
 */
const MIGRATION_LOCK_KEY = 458_000_001;

const FILENAME_PATTERN = /^\d{4}_[a-z0-9]+_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(
  options: { pool?: Pool; dir?: string } = {},
): Promise<MigrationResult> {
  const pool = options.pool ?? sharedPool;
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const badNames = files.filter((f) => !FILENAME_PATTERN.test(f));
  if (badNames.length > 0) {
    throw new Error(`Migration files must be named NNNN_<uc-or-owner>_<description>.sql: ${badNames.join(', ')}`);
  }
  const numbers = files.map((f) => f.slice(0, 4));
  const duplicate = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (duplicate) {
    throw new Error(`Two migrations share number ${duplicate}; rebase and take the next free number.`);
  }

  const client = await pool.connect();
  try {
    // Session-level lock: held across the per-file transactions below.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedChecksums = new Map(rows.map((r) => [r.filename, r.checksum]));

    const result: MigrationResult = { applied: [], alreadyApplied: [] };
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      // Line endings are normalised so a Windows checkout (autocrlf) does not look like an edited migration.
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const previous = appliedChecksums.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was already applied but its contents changed. ` +
              'Never edit an applied migration; add a new one instead.',
          );
        }
        result.alreadyApplied.push(file);
        continue;
      }

      logger.info({ migration: file }, 'applying migration');
      try {
        await client.query('BEGIN');
        // Simple-query protocol: the file may contain many statements and $$-quoted bodies.
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }

    const orphans = [...appliedChecksums.keys()].filter((f) => !files.includes(f));
    if (orphans.length > 0) {
      logger.warn({ orphans }, 'schema_migrations lists files that are not in the migrations directory');
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  runMigrations()
    .then((result) => {
      logger.info(result, 'migrations complete');
    })
    .catch((err: unknown) => {
      logger.fatal({ err }, 'migrations failed');
      process.exitCode = 1;
    })
    .finally(() => sharedPool.end());
}
