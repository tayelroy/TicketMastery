import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { logger } from '../../logger';

/**
 * SNS `order-events` topic ARN, created by infra/modules/messaging (Shi Hui) and passed to the ECS task through
 * extra_environment. Read here rather than in src/config.ts so UC4 doesn't change shared code. Unset locally:
 * events are then only logged, so checkout works without AWS.
 */
const TOPIC_ARN = process.env.ORDER_EVENTS_TOPIC_ARN?.trim() || undefined;

// Region and credentials come from the ECS task (AWS_REGION + task role), so nothing is configured here.
const sns = TOPIC_ARN ? new SNSClient({}) : undefined;

/** Everything ticket-fn needs to render and send the e-ticket, so it never has to read RDS. */
export interface OrderConfirmedEvent {
  type: 'OrderConfirmed';
  version: 1;
  occurredAt: string;
  orderId: string;
  holdId: string;
  fanId: string;
  concert: { id: string; title: string; artist: string; venueName: string; startsAt: string };
  currency: string;
  seats: {
    seatId: string;
    section: string;
    row: string;
    seatNumber: string;
    ticketType: string;
    priceCents: number;
  }[];
  subtotalCents: number;
  bookingFeeCents: number;
  totalCents: number;
}

/**
 * Publishes after the order has committed. A failure is logged, not thrown: the fan has paid and the seats are
 * sold, so the checkout must still succeed. The log line carries the full event so it can be re-sent by hand.
 */
export async function publishOrderConfirmed(event: OrderConfirmedEvent): Promise<void> {
  if (!sns) {
    logger.info({ event }, 'ORDER_EVENTS_TOPIC_ARN not set; OrderConfirmed not published');
    return;
  }
  try {
    const result = await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify(event),
        // Lets subscribers filter by event type (ticket-fn also handles ConcertCancelled).
        MessageAttributes: { eventType: { DataType: 'String', StringValue: event.type } },
      }),
    );
    logger.info({ orderId: event.orderId, messageId: result.MessageId }, 'OrderConfirmed published');
  } catch (err) {
    logger.error({ err, event }, 'failed to publish OrderConfirmed; e-ticket will not be sent automatically');
  }
}
