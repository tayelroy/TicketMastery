import { Router } from 'express';

/** Placeholder for modules whose owner has not implemented them yet: every route answers 501. */
export function notImplementedRouter(module: string, useCase: string, owner: string): Router {
  const router = Router();
  router.use((req, res) => {
    res.status(501).json({
      error: {
        code: 'not_implemented',
        message: `${useCase} ${module} is not implemented yet (owner: ${owner})`,
        details: { module, useCase, owner, method: req.method, path: req.originalUrl },
      },
    });
  });
  return router;
}
