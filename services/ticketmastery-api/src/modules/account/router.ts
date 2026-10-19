import { notImplementedRouter } from '../stub';

/**
 * UC2 My Tickets & Account — owner: Andrew. Mounted at /api/me.
 *
 * TODO(Andrew): replace this stub with the real router. Planned endpoints:
 *   GET /api/me — profile from Cognito claims
 *   GET /api/me/orders — the signed-in fan's orders
 *   GET /api/me/tickets/:id/download — 5-minute pre-signed S3 URL for the e-ticket PDF
 */
export const accountRouter = notImplementedRouter('account', 'UC2', 'Andrew');
