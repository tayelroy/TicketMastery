import { notImplementedRouter } from '../stub';

/**
 * UC1 Concert discovery — owner: Cody & Nai Xin. Mounted at /api/concerts.
 *
 * TODO(Cody & Nai Xin): replace this stub with the real router. Planned endpoints:
 *   GET /api/concerts — public list of published concerts (status scheduled/on_sale/sold_out), search/filter by artist, venue, date
 *   GET /api/concerts/:id — concert detail with ticket types and prices
 *   GET /api/concerts/:id/seats — seat map with live availability (treat held seats whose hold_expires_at < now() as available)
 */
export const discoveryRouter = notImplementedRouter('discovery', 'UC1', 'Cody & Nai Xin');
