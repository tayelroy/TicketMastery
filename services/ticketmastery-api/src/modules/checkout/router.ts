import { notImplementedRouter } from '../stub';

/**
 * UC4 Seat selection & checkout — owner: Shi Hui. Mounted at /api/checkout.
 *
 * TODO(Shi Hui): replace this stub with the real router. Planned endpoints:
 *   POST /api/checkout/holds — hold seats for 10 minutes (all-or-nothing)
 *   DELETE /api/checkout/holds/:holdId — release a hold
 *   POST /api/checkout/holds/:holdId/confirm — simulated payment, mark seats sold, publish OrderConfirmed to SNS `order-events`
 */
export const checkoutRouter = notImplementedRouter('checkout', 'UC4', 'Shi Hui');
