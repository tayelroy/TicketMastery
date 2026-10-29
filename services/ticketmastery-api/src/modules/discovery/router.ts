import { Router } from 'express';
import { asyncHandler } from '../../http/errors';
import { concertIdParams, listConcertsQuery } from './schemas';
import * as service from './service';

/**
 * UC1 Concert discovery (Cody & Nai Xin). Mounted at /api/concerts. Public: no login required, so no
 * `authenticate` here (add it if a route ever needs the optional req.user).
 */
export const discoveryRouter = Router();

discoveryRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = listConcertsQuery.parse(req.query);
    // CloudFront may cache the listing briefly; new concerts appear within a minute.
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await service.listConcerts(filters));
  }),
);

discoveryRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    // Includes per-ticket-type availability, so keep the cache window short.
    res.set('Cache-Control', 'public, max-age=15');
    res.json(await service.getConcert(id));
  }),
);

discoveryRouter.get(
  '/:id/seats',
  asyncHandler(async (req, res) => {
    const { id } = concertIdParams.parse(req.params);
    // Live seat states during checkout; must never be served from a cache.
    res.set('Cache-Control', 'no-store');
    res.json(await service.getSeatMap(id));
  }),
);
