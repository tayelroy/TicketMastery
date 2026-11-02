import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import { logger } from '../../logger';

/**
 * SNS `order-events` topic ARN (infra/modules/messaging), the same topic checkout publishes OrderConfirmed to. Read
 * here rather than in src/config.ts, like UC3/UC4's AWS settings. Unset locally: events are only logged.
 */
const TOPIC_ARN = process.env.ORDER_EVENTS_TOPIC_ARN?.trim() || undefined;

// Region and credentials come from the ECS task (AWS_REGION + task role), so nothing is configured here.
const sns = TOPIC_ARN ? new SNSClient({}) : undefined;

/**
 * One message per confirmed order of a cancelled concert (contract by Shi Hui, PR #20). ticket-fn emails each fan
 * from it without reading RDS, and per-order messages retry independently and stay far below SNS's 256 KB limit.
 */
export interface ConcertCancelledEvent {
  type: 'ConcertCancelled';
  version: 1;
  occurredAt: string;
  orderId: string;
  fanId: string;
  concert: { id: string; title: string; artist: string; venueName: string; startsAt: string };
  reason: string;
  currency: string;
  totalCents: number;
}

/** SNS PublishBatch takes at most 10 entries; a few batches in flight keep a large concert to a few seconds. */
const BATCH_SIZE = 10;
const PARALLEL_BATCHES = 5;

/**
 * Publishes after the cancellation has committed. Returns the order ids SNS did not accept; failures are logged
 * rather than thrown, because the concert is already cancelled. SNS -> SQS delivery is at-least-once and ticket-fn
 * skips orders it has already notified, so publishing an order twice is harmless.
 */
async function publishConcertCancelled(events: ConcertCancelledEvent[]): Promise<{ failedOrderIds: string[] }> {
  if (events.length === 0) return { failedOrderIds: [] };
  if (!sns) {
    logger.info({ count: events.length }, 'ORDER_EVENTS_TOPIC_ARN not set; ConcertCancelled not published');
    return { failedOrderIds: events.map((e) => e.orderId) };
  }

  const batches: ConcertCancelledEvent[][] = [];
  for (let i = 0; i < events.length; i += BATCH_SIZE) batches.push(events.slice(i, i + BATCH_SIZE));

  const failedOrderIds: string[] = [];
  const publishBatch = async (batch: ConcertCancelledEvent[]) => {
    try {
      const result = await sns.send(
        new PublishBatchCommand({
          TopicArn: TOPIC_ARN,
          // Entry ids only need to be unique within the batch; the order id is.
          PublishBatchRequestEntries: batch.map((e) => ({
            Id: e.orderId,
            Message: JSON.stringify(e),
            MessageAttributes: { eventType: { DataType: 'String', StringValue: e.type } },
          })),
        }),
      );
      for (const f of result.Failed ?? []) if (f.Id) failedOrderIds.push(f.Id);
    } catch (err) {
      logger.error({ err, count: batch.length }, 'ConcertCancelled batch publish failed');
      failedOrderIds.push(...batch.map((e) => e.orderId));
    }
  };
  for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
    await Promise.all(batches.slice(i, i + PARALLEL_BATCHES).map(publishBatch));
  }

  const concertId = events[0]!.concert.id;
  if (failedOrderIds.length > 0) {
    logger.error({ concertId, failedOrderIds }, 'some ConcertCancelled events were not published');
  }
  logger.info(
    { concertId, orders: events.length, published: events.length - failedOrderIds.length },
    'ConcertCancelled published',
  );
  return { failedOrderIds };
}

/** Called through this object (not imported directly) so tests can replace the publisher. */
export const organiserEvents = { publishConcertCancelled };
