import { Router } from 'express';
import { authenticate, ORGANISERS_GROUP, requireGroup } from '../../auth';
import { asyncHandler } from '../../http/errors';
import { salesReportQuery } from './schemas';
import * as service from './service';

/** UC5 internal reporting (Elroy). Mounted at /api/reports; its own ECS service, connected as reporting_ro. */
export const reportingRouter = Router();

reportingRouter.use(authenticate, requireGroup(ORGANISERS_GROUP));

reportingRouter.get(
  '/sales',
  asyncHandler(async (req, res) => {
    const query = salesReportQuery.parse(req.query);
    // Live from the views on every request; never served from a cache.
    res.set('Cache-Control', 'no-store');
    res.json(await service.getSalesReport(req.user!.sub, query));
  }),
);
