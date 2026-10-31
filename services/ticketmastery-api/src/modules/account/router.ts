import { Router } from 'express';
import { authenticate, requireUser } from '../../auth';
import { asyncHandler } from '../../http/errors';
import { ticketIdParams } from './schemas';
import * as service from './service';

/** UC2 My Tickets & Account (Andrew). Mounted at /api/me. Every route needs a signed-in user (any group). */
export const accountRouter = Router();

accountRouter.use(authenticate, requireUser, (_req, res, next) => {
  // Personal data, and the download URL works for whoever holds it: never keep any of it in a cache.
  res.set('Cache-Control', 'no-store');
  next();
});

accountRouter.get('/', (req, res) => {
  res.json(service.getMe(req.user!));
});

accountRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    res.json({ orders: await service.listMyOrders(req.user!.sub) });
  }),
);

accountRouter.get(
  '/tickets/:ticketId',
  asyncHandler(async (req, res) => {
    const { ticketId } = ticketIdParams.parse(req.params);
    res.json(await service.getMyTicket(req.user!.sub, ticketId));
  }),
);

accountRouter.get(
  '/tickets/:ticketId/download',
  asyncHandler(async (req, res) => {
    const { ticketId } = ticketIdParams.parse(req.params);
    res.json(await service.ticketDownloadUrl(req.user!.sub, ticketId));
  }),
);
