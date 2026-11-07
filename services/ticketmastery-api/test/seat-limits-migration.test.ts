/**
 * Migration 0005 (1-3 seats per order) on a real Postgres: migrates a throwaway schema to 0004 only, adds ticket
 * types with the old limits (including on a concert whose layout is locked), then applies 0005 and checks the clamp,
 * the new default and the CHECK. Skipped when DB_HOST is unset, like seat-inventory.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as MigrateModule from '../src/db/migrate';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
/** Same directory from test/ (tsx) and coverage/build/test (compiled); test:coverage copies migrations/ there. */
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

describe(
  'migration 0005: max_per_order 1-3 (Postgres)',
  { skip: process.env.DB_HOST ? false : 'DB_HOST not set' },
  () => {
    // Dynamic imports: config.ts validates the DB env on import, and PGOPTIONS must be set before pool.ts loads.
    let db: typeof PoolModule;
    let migrate: typeof MigrateModule;
    let before0005: string;

    async function insertConcert(): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO concerts (organiser_id, title, artist, venue_name, starts_at, sale_starts_at, sale_ends_at)
       VALUES ('org-test', 'Old limits', 'Test Artist', 'Test Hall', now() + interval '3 days',
               now() + interval '1 day', now() + interval '2 days')
       RETURNING id`,
      );
      return rows[0]!.id;
    }

    async function insertTicketType(concertId: string, name: string, maxPerOrder: number) {
      await db.query(
        `INSERT INTO ticket_types (concert_id, name, price_cents, quantity, max_per_order) VALUES ($1, $2, 5000, 10, $3)`,
        [concertId, name, maxPerOrder],
      );
    }

    async function limits(concertId: string) {
      const { rows } = await db.query<{ name: string; max_per_order: number }>(
        'SELECT name, max_per_order FROM ticket_types WHERE concert_id = $1 ORDER BY name',
        [concertId],
      );
      return Object.fromEntries(rows.map((r) => [r.name, r.max_per_order]));
    }

    before(async () => {
      process.env.PGOPTIONS = `-c search_path=${schema},public`;
      db = await import('../src/db/pool.js');
      migrate = await import('../src/db/migrate.js');
      await db.query(`CREATE SCHEMA ${schema}`);
      before0005 = await mkdtemp(path.join(tmpdir(), 'tm-migrations-'));
      for (const file of await readdir(MIGRATIONS_DIR)) {
        if (/^000[1-4]_.*\.sql$/.test(file))
          await copyFile(path.join(MIGRATIONS_DIR, file), path.join(before0005, file));
      }
    });

    after(async () => {
      await rm(before0005, { recursive: true, force: true });
      await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db?.pool.end();
    });

    test('clamps old limits to 3 (locked concerts too), defaults to 3 and rejects 4', async () => {
      const upTo0004 = await migrate.runMigrations({ dir: before0005 });
      assert.equal(upTo0004.applied.length, 4);

      const open = await insertConcert();
      const locked = await insertConcert();
      await insertTicketType(open, 'A', 2);
      await insertTicketType(open, 'B', 4);
      await insertTicketType(open, 'C', 20);
      await insertTicketType(locked, 'A', 4);
      await db.query('UPDATE concerts SET layout_locked_at = now() WHERE id = $1', [locked]);

      const rest = await migrate.runMigrations();
      assert.deepEqual(rest.applied, ['0005_uc4_max_three_seats_per_order.sql']);
      assert.deepEqual(await limits(open), { A: 2, B: 3, C: 3 });
      assert.deepEqual(await limits(locked), { A: 3 });

      await db.query(`INSERT INTO ticket_types (concert_id, name, price_cents, quantity) VALUES ($1, 'D', 5000, 10)`, [
        open,
      ]);
      assert.equal((await limits(open)).D, 3);

      await assert.rejects(insertTicketType(open, 'E', 4), {
        code: '23514',
        constraint: 'ticket_types_max_per_order_range',
      });
      await assert.rejects(insertTicketType(open, 'E', 0), { code: '23514' });
    });
  },
);
