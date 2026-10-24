import { Router, type RequestHandler } from 'express';
import { authenticate } from '../../auth';
import { asyncHandler, HttpError } from '../../http/errors';
import { createHoldBody } from './schemas';
import * as service from './service';

/**
 * UC4 Seat selection & checkout (Shi Hui). Mounted at /api/checkout.
 *
 * TODO(Shi Hui): still to come:
 *   DELETE /api/checkout/holds/:holdId — release a hold
 *   POST /api/checkout/holds/:holdId/confirm — simulated payment, mark seats sold, publish OrderConfirmed to SNS `order-events`
 */
export const checkoutRouter = Router();

/** Any signed-in fan (no group needed). */
const requireUser: RequestHandler = (req, _res, next) => {
  next(req.user ? undefined : new HttpError(401, 'unauthenticated', 'Authentication required'));
};

checkoutRouter.use(authenticate, requireUser);

checkoutRouter.post(
  '/holds',
  asyncHandler(async (req, res) => {
    const body = createHoldBody.parse(req.body);
    res.set('Cache-Control', 'no-store');
    res.status(201).json(await service.createHold(req.user!.sub, body));
  }),
);
