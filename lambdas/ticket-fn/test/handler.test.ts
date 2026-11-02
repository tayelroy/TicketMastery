import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { AdminGetUserCommand, UserNotFoundException } from '@aws-sdk/client-cognito-identity-provider';
import { HeadObjectCommand, NotFound, PutObjectCommand } from '@aws-sdk/client-s3';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { cancelledMarkerKey, createHandler, type Deps, sentMarkerKey, ticketPdfKey } from '../src/handler.js';

const ORDER_ID = '0b6f5c1e-8a7d-4f53-9a51-2f7b1f0c9e11';
const FAN_ID = '5a1b2c3d-0000-4000-8000-123456789abc';
const OCCURRED_AT = '2026-11-03T10:00:00.000Z';

const orderConfirmed = {
  type: 'OrderConfirmed',
  version: 1,
  occurredAt: OCCURRED_AT,
  orderId: ORDER_ID,
  holdId: 'd1e2f3a4-1111-4222-8333-444455556666',
  fanId: FAN_ID,
  concert: {
    id: 'c0ffee00-1111-4222-8333-444455556666',
    title: 'Eras Tour — Singapore Night 1',
    artist: 'Taylor Swift',
    venueName: 'National Stadium',
    startsAt: '2026-12-05T11:30:00.000Z',
  },
  currency: 'SGD',
  seats: [
    { seatId: 's1', section: 'Cat 1', row: 'A', seatNumber: '2', ticketType: 'Standard', priceCents: 24800 },
    { seatId: 's2', section: 'Cat 1', row: 'A', seatNumber: '10', ticketType: 'Standard', priceCents: 24800 },
  ],
  subtotalCents: 49600,
  bookingFeeCents: 800,
  totalCents: 50400,
};

const concertCancelled = {
  type: 'ConcertCancelled',
  version: 1,
  occurredAt: '2026-11-04T02:00:00.000Z',
  orderId: ORDER_ID,
  fanId: FAN_ID,
  concert: orderConfirmed.concert,
  reason: 'Artist unwell',
  currency: 'SGD',
  totalCents: 50400,
};

/** The text part of a raw email, decoded. */
function mimeText(raw: Uint8Array): string {
  const mime = Buffer.from(raw).toString('utf8');
  const part = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n\r\n')[0]!;
  return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

function record(messageId: string, body: unknown, eventType?: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `rh-${messageId}`,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '0',
      SenderId: 'sns',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: eventType ? { eventType: { dataType: 'String', stringValue: eventType } } : {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-1:000000000000:ticket-queue',
    awsRegion: 'ap-southeast-1',
  };
}

const batch = (...records: SQSRecord[]): SQSEvent => ({ Records: records });

/** In-memory bucket + recorded SES/Cognito calls, standing in for the AWS SDK clients. */
function fakeAws() {
  const objects = new Map<string, { body: unknown; contentType?: string }>();
  const emails: Uint8Array[] = [];
  const logs: Record<string, unknown>[] = [];
  const state = { failSes: false, failCognito: false, noCognitoUser: false };

  const deps: Deps = {
    bucket: 'tickets-bucket',
    fromAddress: 'sender@example.com',
    userPoolId: 'ap-southeast-1_test',
    now: () => Date.parse(OCCURRED_AT) + 1234,
    log: (entry) => logs.push(entry),
    s3: {
      send: (async (command: unknown) => {
        if (command instanceof HeadObjectCommand) {
          if (!objects.has(command.input.Key!)) throw new NotFound({ message: 'NotFound', $metadata: {} });
          return {};
        }
        if (command instanceof PutObjectCommand) {
          objects.set(command.input.Key!, { body: command.input.Body, contentType: command.input.ContentType });
          return {};
        }
        throw new Error(`unexpected S3 command ${String(command)}`);
      }) as Deps['s3']['send'],
    },
    ses: {
      send: (async (command: unknown) => {
        assert.ok(command instanceof SendEmailCommand);
        // The IAM policy only allows sending when ses:FromAddress is the configured sender.
        assert.equal(command.input.FromEmailAddress, 'sender@example.com');
        if (state.failSes) throw Object.assign(new Error('Maximum sending rate exceeded'), { name: 'TooManyRequests' });
        emails.push(command.input.Content!.Raw!.Data!);
        return { MessageId: `ses-${emails.length}` };
      }) as Deps['ses']['send'],
    },
    cognito: {
      send: (async (command: unknown) => {
        assert.ok(command instanceof AdminGetUserCommand);
        assert.equal(command.input.Username, FAN_ID);
        assert.equal(command.input.UserPoolId, 'ap-southeast-1_test');
        if (state.failCognito) throw new Error('Cognito unavailable');
        if (state.noCognitoUser) throw new UserNotFoundException({ message: 'User does not exist.', $metadata: {} });
        return { Username: FAN_ID, UserAttributes: [{ Name: 'email', Value: 'fan@example.com' }] };
      }) as Deps['cognito']['send'],
    },
  };
  return { deps, objects, emails, logs, state };
}

describe('ticket-fn handler', () => {
  let aws = fakeAws();
  beforeEach(() => {
    aws = fakeAws();
  });

  test('OrderConfirmed: writes the PDF, sends one email with it attached, then the sent marker', async () => {
    const result = await createHandler(aws.deps)(batch(record('m1', orderConfirmed, 'OrderConfirmed')));

    assert.deepEqual(result, { batchItemFailures: [] });
    const pdf = aws.objects.get(ticketPdfKey(ORDER_ID));
    assert.ok(pdf, 'PDF stored at tickets/<orderId>.pdf');
    assert.equal(pdf.contentType, 'application/pdf');
    assert.ok(pdf.body instanceof Uint8Array);
    assert.equal(Buffer.from(pdf.body.subarray(0, 4)).toString('latin1'), '%PDF');
    assert.ok(aws.objects.has(sentMarkerKey(ORDER_ID)), 'sent marker written');

    assert.equal(aws.emails.length, 1);
    const mime = Buffer.from(aws.emails[0]!).toString('utf8');
    assert.match(mime, /^From: TicketMastery <sender@example\.com>\r\n/);
    assert.match(mime, /\r\nTo: fan@example\.com\r\n/);
    assert.match(mime, /Content-Type: application\/pdf; name="ticketmastery-0b6f5c1e/);
    // The attachment is the same PDF that went to S3.
    assert.ok(mime.includes(Buffer.from(pdf.body).toString('base64').slice(0, 76)));
  });

  test('logs the delivery latency once, as a JSON line that is also an EMF metric', async () => {
    await createHandler(aws.deps)(batch(record('m1', orderConfirmed, 'OrderConfirmed')));

    const sent = aws.logs.filter((l) => l.msg === 'e-ticket sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.orderId, ORDER_ID);
    assert.equal(sent[0]!.occurredAt, OCCURRED_AT);
    assert.equal(sent[0]!.deliveryLatencyMs, 1234);
    assert.equal(sent[0]!.ETicketDeliveryLatency, 1234);
    assert.deepEqual(sent[0]!._aws, {
      Timestamp: Date.parse(OCCURRED_AT) + 1234,
      CloudWatchMetrics: [
        {
          Namespace: 'TicketMastery',
          Dimensions: [[]],
          Metrics: [{ Name: 'ETicketDeliveryLatency', Unit: 'Milliseconds' }],
        },
      ],
    });
  });

  test('duplicate delivery of the same order sends no second email', async () => {
    const handler = createHandler(aws.deps);
    await handler(batch(record('m1', orderConfirmed, 'OrderConfirmed')));
    const result = await handler(batch(record('m2', orderConfirmed, 'OrderConfirmed')));

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(aws.emails.length, 1);
    assert.ok(aws.logs.some((l) => l.msg === 'e-ticket already sent; duplicate delivery skipped'));
  });

  test('a send that failed is retried and the email still goes out exactly once', async () => {
    const handler = createHandler(aws.deps);
    aws.state.failSes = true;
    const first = await handler(batch(record('m1', orderConfirmed, 'OrderConfirmed')));
    assert.deepEqual(first, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
    assert.ok(!aws.objects.has(sentMarkerKey(ORDER_ID)), 'no marker without a successful send');

    aws.state.failSes = false;
    const retry = await handler(batch(record('m1', orderConfirmed, 'OrderConfirmed')));
    assert.deepEqual(retry, { batchItemFailures: [] });
    assert.equal(aws.emails.length, 1);
  });

  test('unknown event types are logged and skipped, not failed', async () => {
    const other = { type: 'SeatMapChanged', version: 1, concertId: 'c1' };
    const result = await createHandler(aws.deps)(batch(record('m1', other, 'SeatMapChanged'), record('m2', other)));

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(aws.objects.size, 0);
    assert.equal(aws.emails.length, 0);
    assert.equal(aws.logs.filter((l) => l.msg === 'event type not handled; skipped').length, 2);
  });

  test('ConcertCancelled: one email with the reason and refund, no attachment, then its own marker', async () => {
    const result = await createHandler(aws.deps)(batch(record('m1', concertCancelled, 'ConcertCancelled')));

    assert.deepEqual(result, { batchItemFailures: [] });
    assert.equal(aws.emails.length, 1);
    const mime = Buffer.from(aws.emails[0]!).toString('utf8');
    assert.match(mime, /\r\nTo: fan@example\.com\r\n/);
    assert.ok(!mime.includes('application/pdf'), 'no attachment');
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    const subject = Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mime)![1]!, 'base64').toString('utf8');
    assert.equal(subject, `Cancelled: ${concertCancelled.concert.title}`);
    const text = mimeText(aws.emails[0]!);
    assert.match(text, /Reason: Artist unwell/);
    assert.match(text, /You will be refunded SGD 504\.00\./);
    assert.ok(aws.objects.has(cancelledMarkerKey(ORDER_ID)));
    assert.ok(!aws.objects.has(ticketPdfKey(ORDER_ID)), 'no PDF for a cancellation');
  });

  test('the e-ticket and the cancellation of the same order are separate emails, each sent once', async () => {
    const handler = createHandler(aws.deps);
    await handler(batch(record('m1', orderConfirmed, 'OrderConfirmed')));
    await handler(batch(record('m2', concertCancelled, 'ConcertCancelled')));
    const repeat = await handler(batch(record('m3', concertCancelled, 'ConcertCancelled')));

    assert.deepEqual(repeat, { batchItemFailures: [] });
    assert.equal(aws.emails.length, 2);
    assert.ok(aws.logs.some((l) => l.msg === 'cancellation notice already sent; duplicate delivery skipped'));
  });

  test('a fan without a Cognito user gets the fallback address when one is set, and fails otherwise', async () => {
    aws.state.noCognitoUser = true;
    const withoutFallback = await createHandler(aws.deps)(batch(record('m1', concertCancelled, 'ConcertCancelled')));
    assert.deepEqual(withoutFallback, {
      batchItemFailures: [{ itemIdentifier: 'm1' }],
    });
    assert.equal(aws.emails.length, 0);
    assert.ok(!aws.objects.has(cancelledMarkerKey(ORDER_ID)));

    const withFallback = await createHandler({
      ...aws.deps,
      fallbackRecipient: 'tester@example.com',
    })(batch(record('m1', concertCancelled, 'ConcertCancelled')));
    assert.deepEqual(withFallback, { batchItemFailures: [] });
    assert.match(Buffer.from(aws.emails[0]!).toString('utf8'), /\r\nTo: tester@example\.com\r\n/);
  });

  test('only the failing record is reported in batchItemFailures', async () => {
    const other = { ...orderConfirmed, orderId: '11111111-2222-4333-8444-555555555555' };
    const invalid = { ...orderConfirmed, orderId: '../../etc/passwd' };
    const result = await createHandler(aws.deps)(
      batch(
        record('ok-1', orderConfirmed, 'OrderConfirmed'),
        record('bad-json', '{not json', 'OrderConfirmed'),
        record('bad-id', invalid, 'OrderConfirmed'),
        record('ok-2', other, 'OrderConfirmed'),
      ),
    );

    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'bad-json' }, { itemIdentifier: 'bad-id' }] });
    assert.equal(aws.emails.length, 2);
  });

  test('a Cognito failure is reported and nothing is marked as sent', async () => {
    aws.state.failCognito = true;
    const result = await createHandler(aws.deps)(batch(record('m1', orderConfirmed, 'OrderConfirmed')));

    assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
    assert.equal(aws.emails.length, 0);
    assert.ok(!aws.objects.has(sentMarkerKey(ORDER_ID)));
    assert.ok(aws.logs.some((l) => l.level === 'error' && l.messageId === 'm1'));
  });
});
