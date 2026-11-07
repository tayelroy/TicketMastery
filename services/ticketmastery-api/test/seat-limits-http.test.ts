/**
 * The 1-3 seats per order rule (src/modules/seat-limits.ts) at the API edge, no database: the real createApp() on an
 * ephemeral port in AUTH_MODE=dev-header. Both requests below are rejected by the body schema before any query, so
 * DB_HOST is 'unused'. The database side (migration 0005's clamp, default and CHECK) is in
 * seat-limits-migration.test.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type * as CheckoutSchemasModule from '../src/modules/checkout/schemas';
import type * as OrganiserSchemasModule from '../src/modules/organiser/schemas';

describe('1-3 seats per order over HTTP (no database)', () => {
  let server: Server;
  let baseUrl: string;
  let checkoutSchemas: typeof CheckoutSchemasModule;
  let organiserSchemas: typeof OrganiserSchemasModule;

  before(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DB_HOST: 'unused',
      DB_NAME: 'unused',
      DB_USER: 'unused',
      DB_PASSWORD: 'unused',
      AUTH_MODE: 'dev-header',
    });
    delete process.env.API_MODULES;
    // Dynamic: src/config.ts validates process.env on import, so the env above must be in place first.
    checkoutSchemas = await import('../src/modules/checkout/schemas.js');
    organiserSchemas = await import('../src/modules/organiser/schemas.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function send(method: string, path: string, headers: Record<string, string>, body: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { error: { code: string; details: { path: string }[] } } };
  }

  const ticketType = (extra: Record<string, unknown> = {}) => ({
    name: 'GA',
    priceCents: 5000,
    quantity: 10,
    ...extra,
  });

  test('a hold of 4 seats is a 400 validation_error on seatIds', async () => {
    const seatIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const res = await send(
      'POST',
      '/api/checkout/holds',
      { 'x-dev-user-id': 'fan-1' },
      { concertId: randomUUID(), seatIds },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
    assert.deepEqual(
      res.body.error.details.map((d) => d.path),
      ['seatIds'],
    );
  });

  test('the hold body accepts 1-3 seats', () => {
    for (const n of [1, 2, 3]) {
      const seatIds = Array.from({ length: n }, () => randomUUID());
      assert.equal(
        checkoutSchemas.createHoldBody.safeParse({ concertId: randomUUID(), seatIds }).success,
        true,
        `${n}`,
      );
    }
  });

  test('ticket types with maxPerOrder 4 are a 400 validation_error', async () => {
    const res = await send(
      'PUT',
      `/api/organiser/concerts/${randomUUID()}/ticket-types`,
      { 'x-dev-user-id': 'org-1', 'x-dev-user-groups': 'organisers' },
      { ticketTypes: [ticketType({ maxPerOrder: 4 })] },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
    assert.deepEqual(
      res.body.error.details.map((d) => d.path),
      ['ticketTypes.0.maxPerOrder'],
    );
  });

  test('maxPerOrder defaults to 3 and accepts 1-3', () => {
    const { replaceTicketTypesBody } = organiserSchemas;
    assert.equal(replaceTicketTypesBody.parse({ ticketTypes: [ticketType()] }).ticketTypes[0]!.maxPerOrder, 3);
    for (const maxPerOrder of [1, 2, 3]) {
      const parsed = replaceTicketTypesBody.parse({ ticketTypes: [ticketType({ maxPerOrder })] });
      assert.equal(parsed.ticketTypes[0]!.maxPerOrder, maxPerOrder);
    }
    assert.equal(replaceTicketTypesBody.safeParse({ ticketTypes: [ticketType({ maxPerOrder: 0 })] }).success, false);
  });
});
