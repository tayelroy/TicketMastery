/**
 * Idempotent local/demo seed: one draft concert owned by `org-1` (the dev-header organiser used in the
 * README), two ticket types and a 2 sections x 3 rows x 10 seats layout. Goes through the organiser
 * service, so it exercises exactly the code path the API uses. Re-running re-applies ticket types and
 * layout while the concert is still editable, and leaves it alone once locked.
 */
import { logger } from '../logger';
import * as service from '../modules/organiser/service';
import { findConcertByOrganiserAndTitle } from '../modules/organiser/repository';
import { pool } from './pool';

const ORGANISER_ID = 'org-1';
const TITLE = 'TicketMastery Demo Night';
const DAY_MS = 24 * 60 * 60 * 1000;

async function seed() {
  const existing = await findConcertByOrganiserAndTitle(pool, ORGANISER_ID, TITLE);
  let concertId: string;
  if (!existing) {
    const now = Date.now();
    const created = await service.createConcert(ORGANISER_ID, {
      title: TITLE,
      artist: 'The Cloud Natives',
      description: 'Demo concert created by npm run seed.',
      venueName: 'Singapore Indoor Stadium',
      venueAddress: '2 Stadium Walk, Singapore 397691',
      saleStartsAt: new Date(now + 30 * DAY_MS).toISOString(),
      saleEndsAt: new Date(now + 59 * DAY_MS).toISOString(),
      startsAt: new Date(now + 60 * DAY_MS).toISOString(),
      endsAt: new Date(now + 60 * DAY_MS + 3 * 60 * 60 * 1000).toISOString(),
    });
    concertId = created.id;
    logger.info({ concertId }, 'created demo concert');
  } else if (existing.layout_locked) {
    logger.info({ concertId: existing.id, status: existing.status }, 'demo concert is locked; leaving it unchanged');
    return;
  } else {
    concertId = existing.id;
  }

  // 2 sections x 3 rows x 10 seats: rows A (CAT1) and B, C (CAT2) in each section.
  await service.replaceTicketTypes(ORGANISER_ID, concertId, {
    ticketTypes: [
      { name: 'CAT1', description: 'Front rows', priceCents: 18_800, currency: 'SGD', quantity: 20, maxPerOrder: 4 },
      { name: 'CAT2', description: 'Rear rows', priceCents: 12_800, currency: 'SGD', quantity: 40, maxPerOrder: 4 },
    ],
  });
  const rows = [
    { label: 'A', ticketTypeName: 'CAT1', seats: { from: 1, to: 10 } },
    { label: 'B', ticketTypeName: 'CAT2', seats: { from: 1, to: 10 } },
    { label: 'C', ticketTypeName: 'CAT2', seats: { from: 1, to: 10 } },
  ];
  const layout = await service.replaceLayout(ORGANISER_ID, concertId, {
    sections: [
      { name: 'Left', rows },
      { name: 'Right', rows },
    ],
  });
  logger.info({ concertId, layout }, 'seeded demo concert ticket types and layout');
}

seed()
  .catch((err: unknown) => {
    logger.fatal({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
