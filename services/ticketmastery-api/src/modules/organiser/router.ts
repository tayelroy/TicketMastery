import { Router } from 'express';
import { authenticate, ORGANISERS_GROUP, requireGroup } from '../../auth';
import { asyncHandler } from '../../http/errors';
import {
  cancelConcertBody,
  concertIdParams,
  createConcertBody,
  replaceLayoutBody,
  replaceTicketTypesBody,
} from './schemas';
import * as service from './service';

/** UC5 Concert & Ticket Management (Elroy). Mounted at /api/organiser. */
export const organiserRouter = Router();

organiserRouter.use(authenticate, requireGroup(ORGANISERS_GROUP));

organiserRouter.post(
  '/concerts',
  asyncHandler(async (req, res) => {
    const body = createConcertBody.parse(req.body);
    res.status(201).json(await service.createConcert(req.user!.sub, body));
  }),
);

organiserRouter.get(
  '/concerts',
  asyncHandler(async (req, res) => {
    res.json({ concerts: await service.listConcerts(req.user!.sub) });
  }),
);

organiserRouter.get(
  '/concerts/:id',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    res.json(await service.getConcertDetail(req.user!.sub, id));
  }),
);

organiserRouter.put(
  '/concerts/:id/ticket-types',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    const body = replaceTicketTypesBody.parse(req.body);
    res.json(await service.replaceTicketTypes(req.user!.sub, id, body));
  }),
);

organiserRouter.put(
  '/concerts/:id/layout',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    const body = replaceLayoutBody.parse(req.body);
    res.json(await service.replaceLayout(req.user!.sub, id, body));
  }),
);

organiserRouter.post(
  '/concerts/:id/publish',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    res.json(await service.publishConcert(req.user!.sub, id));
  }),
);

organiserRouter.post(
  '/concerts/:id/cancel',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    const { reason } = cancelConcertBody.parse(req.body);
    res.json(await service.cancelConcert(req.user!.sub, id, reason));
  }),
);

organiserRouter.get(
  '/concerts/:id/dashboard',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    // Polled every 5s by the organiser UI; must never be served from a cache.
    res.set('Cache-Control', 'no-store');
    res.json(await service.getDashboard(req.user!.sub, id));
  }),
);
