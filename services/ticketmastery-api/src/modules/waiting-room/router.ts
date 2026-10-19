import { notImplementedRouter } from '../stub';

/**
 * UC3 Virtual waiting room — owner: Yan Ting. Mounted at /api/waiting-room.
 *
 * TODO(Yan Ting): replace this stub with the real router. Planned endpoints:
 *   POST /api/waiting-room/:concertId/join — enqueue the fan (SQS FIFO `join-queue`) and return a queue position
 *   GET /api/waiting-room/:concertId/status — position / admission token from DynamoDB `live-queue`
 */
export const waitingRoomRouter = notImplementedRouter('waiting-room', 'UC3', 'Yan Ting');
