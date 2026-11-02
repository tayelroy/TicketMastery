/**
 * UC3 → UC4 admission check with WAITING_ROOM_TABLE_NAME set: DynamoDBClient.send is replaced, so no AWS or
 * Postgres is needed. Its own file because the waiting-room queue reads the table name once, when it is first
 * imported (checkout.test.ts runs without one, where every fan is admitted).
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import assert from 'node:assert/strict';
import { afterEach, before, describe, mock, test } from 'node:test';
import type * as AdmissionModule from '../src/modules/checkout/admission';
import type * as ServiceModule from '../src/modules/checkout/service';
import type { HttpError } from '../src/http/errors';

const TABLE = 'live-queue-test';
const CONCERT = '7b1841b9-a076-4469-8a95-1ea37e01fe03';
const SEAT = '3b0c7f1e-6f43-4c1a-9d43-8a6f1c2b5e10';
const NOW = 1_800_000_000_000;

describe('checkout admission (WAITING_ROOM_TABLE_NAME set, DynamoDB replaced)', () => {
  let admission: typeof AdmissionModule;
  let service: typeof ServiceModule;

  before(async () => {
    Object.assign(process.env, {
      WAITING_ROOM_TABLE_NAME: TABLE,
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTONLY0000',
      AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
    });
    delete process.env.AWS_PROFILE;
    delete process.env.AWS_SESSION_TOKEN;
    // Dynamic: queue.ts reads WAITING_ROOM_TABLE_NAME at import time, so it must load after the env is set.
    admission = await import('../src/modules/checkout/admission.js');
    service = await import('../src/modules/checkout/service.js');
  });

  afterEach(() => mock.restoreAll());

  /** Answers GetItem with `item` (undefined = no row) and records the commands sent. */
  function liveQueueRow(item: Record<string, unknown> | undefined) {
    const sent: GetItemCommand[] = [];
    mock.method(DynamoDBClient.prototype, 'send', async (command: GetItemCommand) => {
      sent.push(command);
      return { Item: item };
    });
    return sent;
  }

  const row = (status: string, admissionExpiresAt?: number) => ({
    eventId: { S: CONCERT },
    userId: { S: 'fan-1' },
    status: { S: status },
    position: { N: '42' },
    ...(admissionExpiresAt !== undefined && { admissionExpiresAt: { N: String(admissionExpiresAt) } }),
  });

  test('reads the fan row keyed by concert + fan', async () => {
    const sent = liveQueueRow(row('ADMITTED', NOW / 1000 + 600));
    assert.equal(await admission.isAdmitted('fan-1', CONCERT, NOW), true);
    assert.equal(sent.length, 1);
    assert.ok(sent[0] instanceof GetItemCommand);
    assert.deepEqual(sent[0].input, { TableName: TABLE, Key: { eventId: { S: CONCERT }, userId: { S: 'fan-1' } } });
  });

  test('admitted only while admissionExpiresAt is ahead', async () => {
    liveQueueRow(row('ADMITTED', NOW / 1000 - 1));
    assert.equal(await admission.isAdmitted('fan-1', CONCERT, NOW), false);
  });

  test('waiting, expired or never queued -> not admitted', async () => {
    for (const item of [row('WAITING'), row('EXPIRED'), undefined]) {
      mock.restoreAll();
      liveQueueRow(item);
      assert.equal(await admission.isAdmitted('fan-1', CONCERT, NOW), false, JSON.stringify(item));
    }
  });

  test('createHold answers 403 not_admitted before touching seats', async () => {
    liveQueueRow(row('WAITING'));
    await assert.rejects(service.createHold('fan-1', { concertId: CONCERT, seatIds: [SEAT] }), (err: HttpError) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'not_admitted');
      return true;
    });
  });

  test('a DynamoDB failure is not treated as admitted', async () => {
    mock.method(DynamoDBClient.prototype, 'send', async () => {
      throw new Error('throttled');
    });
    await assert.rejects(admission.isAdmitted('fan-1', CONCERT, NOW), /throttled/);
  });
});
