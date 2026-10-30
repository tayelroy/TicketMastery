import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../auth';
import { asyncHandler, HttpError } from '../../http/errors';
import { concertIdParams, confirmHoldBody, createHoldBody, holdIdParams } from './schemas';
import * as service from './service';

/** UC4 Seat selection & checkout (Shi Hui). Mounted at /api/checkout. */
export const checkoutRouter = Router();

/** Any signed-in fan (no group needed). */
const requireUser: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new HttpError(401, 'unauthenticated', 'Authentication required'));
};

checkoutRouter.use(authenticate, requireUser);

checkoutRouter.get(
  '/concerts/:concertId/seats',
  asyncHandler(async (req, res) => {
    const { concertId } = concertIdParams.parse(req.params);
    res.set('Cache-Control', 'no-store');
    res.json(await service.getSeatMap(req.user!.sub, concertId));
  }),
);

checkoutRouter.post(
  '/holds',
  asyncHandler(async (req, res) => {
    const body = createHoldBody.parse(req.body);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await service.createHold(req.user!.sub, body));
  }),
);

checkoutRouter.delete(
  '/holds/:holdId',
  asyncHandler(async (req, res) => {
    const { holdId } = holdIdParams.parse(req.params);
    res.set('Cache-Control', 'no-store');
    res.json(await service.releaseHold(req.user!.sub, holdId));
  }),
);

checkoutRouter.post(
  '/holds/:holdId/confirm',
  asyncHandler(async (req, res) => {
    const { holdId } = holdIdParams.parse(req.params);
    const body = confirmHoldBody.parse(req.body ?? {});
    res.set('Cache-Control', 'no-store');
    res.json(await service.confirmHold(req.user!.sub, holdId, body));
  }),
);
