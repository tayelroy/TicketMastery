/**
 * Unit tests for UC3 waiting room: the SQS join message and the live-queue row -> status mapping.
 * No Postgres or AWS needed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { joinMessage } from '../src/modules/waiting-room/queue';
import { toQueueStatus } from '../src/modules/waiting-room/status';

const CONCERT = '7b1841b9-a076-4469-8a95-1ea37e01fe03';
const noneAdmitted = { lastPosition: 0, admittedUpTo: 0 };

describe('joinMessage', () => {
  test('body matches what queue-manager reads, grouped per concert', () => {
    const msg = joinMessage(CONCERT, 'fan-1', 1_800_000_000_500);
    assert.deepEqual(JSON.parse(msg.MessageBody), { eventId: CONCERT, userId: 'fan-1', joinedAt: 1_800_000_000 });
    assert.equal(msg.MessageGroupId, CONCERT);
  });

  test('dedup id is stable per fan + concert and within the 128-char limit', () => {
    const a = joinMessage(CONCERT, 'fan-1').MessageDeduplicationId;
    assert.equal(a, joinMessage(CONCERT, 'fan-1', 0).MessageDeduplicationId);
    assert.notEqual(a, joinMessage(CONCERT, 'fan-2').MessageDeduplicationId);
    assert.ok(joinMessage(CONCERT, 'x'.repeat(500)).MessageDeduplicationId.length <= 128);
  });
});

describe('toQueueStatus', () => {
  test('no row yet -> pending', () => {
    assert.deepEqual(toQueueStatus(CONCERT, undefined, noneAdmitted), {
      concertId: CONCERT,
      state: 'pending',
      position: null,
      peopleAhead: null,
      admittedUntil: null,
    });
  });

  test('waiting: people ahead counts only fans not yet admitted', () => {
    const entry = { status: 'WAITING', position: 1248 };
    assert.equal(toQueueStatus(CONCERT, entry, noneAdmitted).peopleAhead, 1247);
    assert.equal(toQueueStatus(CONCERT, entry, { lastPosition: 2000, admittedUpTo: 1000 }).peopleAhead, 247);
    assert.equal(toQueueStatus(CONCERT, entry, { lastPosition: 2000, admittedUpTo: 1500 }).peopleAhead, 0);
  });

  test('admitted until admissionExpiresAt, then expired', () => {
    const entry = { status: 'ADMITTED', position: 3, admissionExpiresAt: 1_800_000_600 };
    const admitted = toQueueStatus(CONCERT, entry, noneAdmitted, 1_800_000_000_000);
    assert.equal(admitted.state, 'admitted');
    assert.equal(admitted.admittedUntil, new Date(1_800_000_600_000).toISOString());
    assert.equal(toQueueStatus(CONCERT, entry, noneAdmitted, 1_800_000_601_000).state, 'expired');
  });
});
