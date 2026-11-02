import {
  AdminGetUserCommand,
  type CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { HeadObjectCommand, NotFound, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  type ConcertCancelledEvent,
  type OrderConfirmedEvent,
  parseConcertCancelled,
  parseOrderConfirmed,
} from './event.js';
import { formatMoney, formatSgt } from './format.js';
import { buildRawEmail } from './mime.js';
import { renderTicketPdf } from './pdf.js';

export interface Deps {
  s3: Pick<S3Client, 'send'>;
  ses: Pick<SESv2Client, 'send'>;
  cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  bucket: string;
  fromAddress: string;
  userPoolId: string;
  /**
   * Testing only (FALLBACK_RECIPIENT_EMAIL): a verified address used when the fan has no Cognito user, as with the
   * dev-header login's made-up ids such as `fan-1`. Unset in AWS, where every fan signs in through Cognito.
   */
  fallbackRecipient?: string;
  /** Injected so tests control the latency figure. */
  now?: () => number;
  /** One JSON object per line on stdout (see log below). */
  log?: (entry: Record<string, unknown>) => void;
}

/** Key agreed with the API's account module (UC2 download link reads it). */
export const ticketPdfKey = (orderId: string) => `tickets/${orderId}.pdf`;

/** Written only after SES accepted the email; its presence is what makes a redelivery skip the send. */
export const sentMarkerKey = (orderId: string) => `tickets/${orderId}.sent`;

/** Same idea for the cancellation notice, which is a separate email for the same order. */
export const cancelledMarkerKey = (orderId: string) => `tickets/${orderId}.cancelled.sent`;

/**
 * Plain JSON lines (not console.log): the Node runtime prefixes console output with a timestamp and request id,
 * which would stop CloudWatch from reading the line as Embedded Metric Format, and JSON lines are what Logs
 * Insights queries by field.
 */
function stdoutLog(entry: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

async function alreadySent(deps: Deps, markerKey: string): Promise<boolean> {
  try {
    await deps.s3.send(new HeadObjectCommand({ Bucket: deps.bucket, Key: markerKey }));
    return true;
  } catch (err) {
    // A 404 needs s3:ListBucket (otherwise S3 answers 403); anything else is a real failure and is retried.
    if (err instanceof NotFound) return false;
    throw err;
  }
}

async function writeMarker(deps: Deps, markerKey: string, sesMessageId: string | undefined, now: number) {
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucket,
      Key: markerKey,
      Body: JSON.stringify({
        sesMessageId,
        sentAt: new Date(now).toISOString(),
      }),
      ContentType: 'application/json',
    }),
  );
}

/**
 * The pool signs fans in by email, so each user's Cognito username is their sub, which is the event's fanId. A fan
 * without a Cognito user (dev-header ids) gets the fallback address when one is configured, otherwise the record
 * fails and ends in the DLQ.
 */
async function fanEmail(deps: Deps, fanId: string, log: NonNullable<Deps['log']>): Promise<string> {
  let email: string | undefined;
  try {
    const user = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: fanId }));
    email = user.UserAttributes?.find((a) => a.Name === 'email')?.Value;
  } catch (err) {
    if (!(err instanceof UserNotFoundException)) throw err;
  }
  if (email) return email;
  if (deps.fallbackRecipient) {
    log({ level: 'warn', msg: 'no Cognito email for fan; using FALLBACK_RECIPIENT_EMAIL', fanId });
    return deps.fallbackRecipient;
  }
  throw new Error(`no email for fan ${fanId} (no Cognito user or email, FALLBACK_RECIPIENT_EMAIL unset)`);
}

/** FromEmailAddress makes the IAM `ses:FromAddress` condition match the sender explicitly. */
async function send(deps: Deps, raw: Uint8Array) {
  return deps.ses.send(
    new SendEmailCommand({
      FromEmailAddress: deps.fromAddress,
      Content: { Raw: { Data: raw } },
    }),
  );
}

function emailText(event: OrderConfirmedEvent): string {
  const seats = event.seats
    .map(
      (s) =>
        `  ${s.section}, row ${s.row}, seat ${s.seatNumber} (${s.ticketType}): ${formatMoney(s.priceCents, event.currency)}`,
    )
    .join('\r\n');
  return [
    'Thank you for your order. Your e-ticket is attached as a PDF.',
    '',
    event.concert.title,
    event.concert.artist,
    event.concert.venueName,
    formatSgt(event.concert.startsAt),
    '',
    'Seats:',
    seats,
    '',
    `Booking fee: ${formatMoney(event.bookingFeeCents, event.currency)}`,
    `Total paid: ${formatMoney(event.totalCents, event.currency)}`,
    `Order: ${event.orderId}`,
    '',
    'You can also download the ticket any time from My Tickets on TicketMastery.',
    '',
  ].join('\r\n');
}

/**
 * Idempotency under SQS at-least-once delivery, in this order:
 *  1. sent marker exists -> already emailed, done;
 *  2. PDF written (overwriting an earlier attempt's copy is harmless: same content);
 *  3. email sent;
 *  4. sent marker written.
 * A crash between 3 and 4 makes the retry send the email again: a rare duplicate is accepted, a lost ticket is not.
 * Two copies of the same message processed at the same moment can also both send; SQS rarely delivers that way.
 */
async function processOrderConfirmed(deps: Deps, event: OrderConfirmedEvent, log: NonNullable<Deps['log']>) {
  const { orderId } = event;
  if (await alreadySent(deps, sentMarkerKey(orderId))) {
    log({ level: 'info', msg: 'e-ticket already sent; duplicate delivery skipped', orderId });
    return;
  }

  const pdf = await renderTicketPdf(event);
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.bucket,
      Key: ticketPdfKey(orderId),
      Body: pdf,
      ContentType: 'application/pdf',
      ContentDisposition: `attachment; filename="ticketmastery-${orderId}.pdf"`,
    }),
  );

  const to = await fanEmail(deps, event.fanId, log);
  const raw = buildRawEmail(
    {
      from: deps.fromAddress,
      to,
      subject: `Your e-ticket: ${event.concert.title}`,
      text: emailText(event),
      attachment: { filename: `ticketmastery-${orderId}.pdf`, contentType: 'application/pdf', data: pdf },
    },
    `=_ticketmastery_${orderId}`,
  );
  const sent = await send(deps, raw);

  const now = (deps.now ?? Date.now)();
  await writeMarker(deps, sentMarkerKey(orderId), sent.MessageId, now);

  // NFR-7 (95 % of e-tickets within 60 s of payment): one line that is both a Logs Insights record and, through
  // Embedded Metric Format, a CloudWatch metric with no dimensions.
  const deliveryLatencyMs = now - new Date(event.occurredAt).getTime();
  log({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: 'TicketMastery',
          Dimensions: [[]],
          Metrics: [{ Name: 'ETicketDeliveryLatency', Unit: 'Milliseconds' }],
        },
      ],
    },
    level: 'info',
    msg: 'e-ticket sent',
    orderId,
    occurredAt: event.occurredAt,
    deliveryLatencyMs,
    ETicketDeliveryLatency: deliveryLatencyMs,
    sesMessageId: sent.MessageId,
  });
}

function cancellationText(event: ConcertCancelledEvent): string {
  const reason = event.reason.trim();
  return [
    `We're sorry: ${event.concert.title} (${event.concert.artist}) at ${event.concert.venueName},`,
    `${formatSgt(event.concert.startsAt)}, has been cancelled by the organiser.`,
    ...(reason ? [`Reason: ${reason}`] : []),
    '',
    `Your tickets for order ${event.orderId} are no longer valid.`,
    `You will be refunded ${formatMoney(event.totalCents, event.currency)}.`,
    '',
    'TicketMastery',
    '',
  ].join('\r\n');
}

/** Same order of steps as the e-ticket, without a PDF: marker check, send, marker. */
async function processConcertCancelled(deps: Deps, event: ConcertCancelledEvent, log: NonNullable<Deps['log']>) {
  const { orderId } = event;
  if (await alreadySent(deps, cancelledMarkerKey(orderId))) {
    log({ level: 'info', msg: 'cancellation notice already sent; duplicate delivery skipped', orderId });
    return;
  }
  const to = await fanEmail(deps, event.fanId, log);
  const raw = buildRawEmail(
    { from: deps.fromAddress, to, subject: `Cancelled: ${event.concert.title}`, text: cancellationText(event) },
    `=_ticketmastery_cancelled_${orderId}`,
  );
  const sent = await send(deps, raw);
  await writeMarker(deps, cancelledMarkerKey(orderId), sent.MessageId, (deps.now ?? Date.now)());
  log({
    level: 'info',
    msg: 'cancellation notice sent',
    orderId,
    concertId: event.concert.id,
    sesMessageId: sent.MessageId,
  });
}

async function processRecord(deps: Deps, record: SQSRecord, log: NonNullable<Deps['log']>) {
  // Raw SNS delivery keeps the publisher's eventType attribute; the body's type covers a message sent without it.
  let eventType = record.messageAttributes?.eventType?.stringValue;
  if (eventType === undefined) {
    const body: unknown = JSON.parse(record.body);
    if (body && typeof body === 'object' && 'type' in body && typeof body.type === 'string') eventType = body.type;
  }
  if (eventType === 'OrderConfirmed') {
    await processOrderConfirmed(deps, parseOrderConfirmed(record.body), log);
  } else if (eventType === 'ConcertCancelled') {
    await processConcertCancelled(deps, parseConcertCancelled(record.body), log);
  } else {
    log({ level: 'info', msg: 'event type not handled; skipped', eventType, messageId: record.messageId });
  }
}

/**
 * Records are handled one at a time: SES in the sandbox allows 1 email per second, and the event source mapping's
 * maximum concurrency (2) already bounds parallelism. Only failed records are returned, so SQS redelivers just those.
 */
export function createHandler(deps: Deps) {
  const log = deps.log ?? stdoutLog;
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      try {
        await processRecord(deps, record, log);
      } catch (err) {
        log({
          level: 'error',
          msg: 'e-ticket failed; message returned to the queue',
          messageId: record.messageId,
          receiveCount: Number(record.attributes?.ApproximateReceiveCount),
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}
