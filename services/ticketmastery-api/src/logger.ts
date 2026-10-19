import pino from 'pino';
import { config } from './config';

/** JSON logs to stdout; the ECS awslogs driver ships them to CloudWatch. */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: 'ticketmastery-api' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-origin-verify"]'],
    censor: '[redacted]',
  },
});
