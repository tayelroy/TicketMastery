/**
 * The ConcertCancelled publisher on its own (no database, no AWS): SNS PublishBatch takes at most 10 entries, so a
 * concert with many orders is split into batches, and entries SNS rejects come back as failed order ids.
 */
import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import assert from 'node:assert/strict';
import { before, describe, mock, test } from 'node:test';
import type * as OrganiserEventsModule from '../src/modules/organiser/events';

describe('ConcertCancelled publisher', () => {
  let events: typeof OrganiserEventsModule;
  const batches: string[][] = [];

  before(async () => {
    // The module reads the topic at import time; fake credentials keep the SDK from looking for a real profile.
    Object.assign(process.env, {
      ORDER_EVENTS_TOPIC_ARN: 'arn:aws:sns:ap-southeast-1:000000000000:order-events',
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'AKIATESTONLY0000',
      AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
      LOG_LEVEL: 'silent',
    });
    delete process.env.AWS_PROFILE;
    mock.method(SNSClient.prototype, 'send', async (command: unknown) => {
      assert.ok(command instanceof PublishBatchCommand);
      const entries = command.input.PublishBatchRequestEntries!;
      batches.push(entries.map((e) => e.Id!));
      for (const e of entries) {
        assert.equal(e.MessageAttributes!.eventType!.StringValue, 'ConcertCancelled');
        assert.equal(JSON.parse(e.Message!).orderId, e.Id);
      }
      // SNS reports per-entry failures in the response instead of failing the whole call.
      return { Failed: entries.filter((e) => e.Id === 'order-13').map((e) => ({ Id: e.Id, Code: 'InternalError' })) };
    });
    events = await import('../src/modules/organiser/events.js');
  });

  test('23 orders go out in batches of at most 10, and a rejected entry is reported', async () => {
    const event = (i: number): OrganiserEventsModule.ConcertCancelledEvent => ({
      type: 'ConcertCancelled',
      version: 1,
      occurredAt: '2026-11-04T02:00:00.000Z',
      orderId: `order-${i}`,
      fanId: `fan-${i}`,
      concert: { id: 'c1', title: 'T', artist: 'A', venueName: 'V', startsAt: '2026-12-01T12:00:00.000Z' },
      reason: 'Artist unwell',
      currency: 'SGD',
      totalCents: 10_400,
    });
    const result = await events.organiserEvents.publishConcertCancelled(Array.from({ length: 23 }, (_, i) => event(i)));

    assert.deepEqual(
      batches.map((b) => b.length),
      [10, 10, 3],
    );
    assert.deepEqual(
      batches.flat(),
      Array.from({ length: 23 }, (_, i) => `order-${i}`),
    );
    assert.deepEqual(result, { failedOrderIds: ['order-13'] });
  });
});
