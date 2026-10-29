import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../auth';
import { asyncHandler, HttpError } from '../../http/errors';
import { concertIdParams } from './schemas';
import * as service from './service';

/** UC3 Virtual waiting room (Yan Ting). Mounted at /api/waiting-room. */
export const waitingRoomRouter = Router();

/** A queue place belongs to a fan, so any signed-in user (no group needed). */
const requireUser: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new HttpError(401, 'unauthenticated', 'Authentication required'));
};

waitingRoomRouter.use(authenticate, requireUser);

waitingRoomRouter.post(
  '/:concertId/join',
  asyncHandler(async (req, res) => {
    const { concertId } = concertIdParams.parse(req.params);
    const status = await service.join(req.user!.sub, concertId);
    res.set('Cache-Control', 'no-store');
    // 202: the number is assigned asynchronously by queue-manager; poll GET /status.
    res.status(status.state === 'pending' ? 202 : 200).json(status);
  }),
);

waitingRoomRouter.get(
  '/:concertId/status',
  asyncHandler(async (req, res) => {
    const { concertId } = concertIdParams.parse(req.params);
    res.set('Cache-Control', 'no-store');
    res.json(await service.getStatus(req.user!.sub, concertId));
  }),
);
