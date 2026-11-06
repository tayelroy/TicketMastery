/**
 * API_MODULES in createApp(): each ECS service mounts only its use case's router, plus the health routes. No database:
 * every probe below is answered before any query (validation 400 or dev-header 401), so "mounted" means "not the
 * not_found 404", and "not mounted" means exactly that 404.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { before, describe, test } from 'node:test';
import type * as AppModule from '../src/app';
import type { ModuleKey } from '../src/modules/keys';

/** One request per module that its router answers without touching the database. */
const probes: Record<ModuleKey, { method: string; path: string }> = {
  discovery: { method: 'GET', path: '/api/concerts/not-a-uuid' },
  account: { method: 'GET', path: '/api/me' },
  'waiting-room': { method: 'POST', path: '/api/waiting-room/not-a-uuid/join' },
  checkout: { method: 'POST', path: '/api/checkout/holds' },
  organiser: { method: 'GET', path: '/api/organiser/concerts' },
  reporting: { method: 'GET', path: '/api/reports/sales' },
};

describe('createApp with API_MODULES', () => {
  let createApp: typeof AppModule.createApp;

  before(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DB_HOST: 'unused',
      DB_NAME: 'unused',
      DB_USER: 'unused',
      DB_PASSWORD: 'unused',
    });
    delete process.env.API_MODULES;
    // Dynamic: src/config.ts validates process.env on import, so the env above must be in place first.
    ({ createApp } = await import('../src/app.js'));
  });

  /** Starts createApp(apiModules) on an ephemeral port, runs `fn` against its base URL, then closes it. */
  async function withApp(apiModules: readonly ModuleKey[] | undefined, fn: (baseUrl: string) => Promise<void>) {
    const server: Server = createApp(apiModules).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  async function probe(baseUrl: string, key: ModuleKey) {
    const { method, path } = probes[key];
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' } });
    const body = (await res.json()) as { error?: { code: string } };
    return { status: res.status, code: body.error?.code };
  }

  test('every registered module has a key in modules/keys.ts, and vice versa', async () => {
    const [{ modules }, { moduleKeys }] = await Promise.all([
      import('../src/modules/index.js'),
      import('../src/modules/keys.js'),
    ]);
    assert.deepEqual(
      modules.map((m) => m.key),
      [...moduleKeys],
    );
  });

  test('API_MODULES unset (the default): every module is mounted', async () => {
    await withApp(undefined, async (baseUrl) => {
      for (const key of Object.keys(probes) as ModuleKey[]) {
        assert.notEqual((await probe(baseUrl, key)).code, 'not_found', key);
      }
    });
  });

  test('a subset mounts only those modules; the others answer not_found 404', async () => {
    for (const selected of [['checkout'], ['discovery', 'organiser'], ['reporting']] as ModuleKey[][]) {
      await withApp(selected, async (baseUrl) => {
        for (const key of Object.keys(probes) as ModuleKey[]) {
          const res = await probe(baseUrl, key);
          if (selected.includes(key)) assert.notEqual(res.code, 'not_found', `${key} with ${selected}`);
          else assert.deepEqual(res, { status: 404, code: 'not_found' }, `${key} with ${selected}`);
        }
      });
    }
  });

  test('health routes are mounted whatever the selection', async () => {
    await withApp(['checkout'], async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health/live`);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { status: string }).status, 'ok');
    });
  });
});
