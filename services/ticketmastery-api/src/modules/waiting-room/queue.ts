import { createHash } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/**
 * SQS FIFO `join-queue` URL and DynamoDB `live-queue` table, created by infra/modules/waiting-room and passed to
 * the ECS task through extra_environment. Read here rather than in src/config.ts so UC3 doesn't change shared
 * code. Unset locally: the routes answer 501 and the frontend falls back to its demo queue.
 */
const JOIN_QUEUE_URL = process.env.WAITING_ROOM_JOIN_QUEUE_URL?.trim() || undefined;
const TABLE_NAME = process.env.WAITING_ROOM_TABLE_NAME?.trim() || undefined;

// Region and credentials come from the ECS task (AWS_REGION + task role), so nothing is configured here.
const sqs = JOIN_QUEUE_URL ? new SQSClient({}) : undefined;
const dynamo = TABLE_NAME ? new DynamoDBClient({}) : undefined;

/** What queue-manager (lambdas/queue-manager) reads from each message body. */
export interface JoinMessage {
  eventId: string;
  userId: string;
  /** Epoch seconds. */
  joinedAt: number;
}

/** The fields of a fan's `live-queue` row (PK eventId, SK userId) that the API reads. */
export interface QueueEntry {
  status: string;
  position: number;
  /** Epoch seconds; set by the admit step when status = ADMITTED. */
  admissionExpiresAt?: number;
}

/** The concert's `#COUNTER` row. `admittedUpTo` is the highest position the admit step has let in so far. */
export interface QueueCounter {
  lastPosition: number;
  admittedUpTo: number;
}

export function joinMessage(concertId: string, userId: string, now = Date.now()) {
  const body: JoinMessage = { eventId: concertId, userId, joinedAt: Math.floor(now / 1000) };
  return {
    MessageBody: JSON.stringify(body),
    // One message group per concert: SQS hands queue-manager each concert's joins in arrival order,
    // while different concerts are processed in parallel.
    MessageGroupId: concertId,
    // Repeat clicks within SQS's 5-minute dedup window collapse into one message. Hashed because the id is
    // capped at 128 chars and user ids are not ours to bound. queue-manager also skips fans already queued.
    MessageDeduplicationId: createHash('sha256').update(`${userId}#${concertId}`).digest('hex'),
  };
}

const num = (v: AttributeValue | undefined) => (v?.N !== undefined ? Number(v.N) : undefined);

async function getItem(eventId: string, userId: string) {
  const { Item } = await dynamo!.send(
    new GetItemCommand({ TableName: TABLE_NAME, Key: { eventId: { S: eventId }, userId: { S: userId } } }),
  );
  return Item;
}

export const waitingRoomQueue = {
  /** False when the env vars are unset (local dev without AWS). */
  isConfigured(): boolean {
    return Boolean(sqs && dynamo);
  },

  async sendJoin(concertId: string, userId: string): Promise<void> {
    await sqs!.send(new SendMessageCommand({ QueueUrl: JOIN_QUEUE_URL, ...joinMessage(concertId, userId) }));
  },

  async getEntry(concertId: string, userId: string): Promise<QueueEntry | undefined> {
    const item = await getItem(concertId, userId);
    if (!item) return undefined;
    return { status: item.status?.S ?? '', position: num(item.position) ?? 0, admissionExpiresAt: num(item.admissionExpiresAt) };
  },

  async getCounter(concertId: string): Promise<QueueCounter> {
    const item = await getItem(concertId, '#COUNTER');
    return { lastPosition: num(item?.lastPosition) ?? 0, admittedUpTo: num(item?.admittedUpTo) ?? 0 };
  },
};
