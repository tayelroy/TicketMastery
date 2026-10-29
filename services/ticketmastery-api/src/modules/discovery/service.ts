import { pool } from '../../db/pool';
import { HttpError } from '../../http/errors';
import * as repo from './repository';
import type { ConcertDetailRow, ConcertSummaryRow, PublicSeatStatus, PublicTicketTypeRow } from './repository';
import type { ListConcertsQuery } from './schemas';

function toConcertSummaryDto(c: ConcertSummaryRow) {
  return {
    id: c.id,
    title: c.title,
    artist: c.artist,
    venueName: c.venue_name,
    startsAt: c.starts_at,
    saleStartsAt: c.sale_starts_at,
    saleEndsAt: c.sale_ends_at,
    status: c.status,
    imageUrl: c.image_url,
    minPriceCents: c.min_price_cents,
    currency: c.currency,
  };
}

function toConcertDetailDto(c: ConcertDetailRow) {
  return {
    id: c.id,
    title: c.title,
    artist: c.artist,
    description: c.description,
    venueName: c.venue_name,
    venueAddress: c.venue_address,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    saleStartsAt: c.sale_starts_at,
    saleEndsAt: c.sale_ends_at,
    status: c.status,
    cancelledAt: c.cancelled_at,
    cancellationReason: c.cancellation_reason,
    imageUrl: c.image_url,
  };
}

function toTicketTypeDto(t: PublicTicketTypeRow) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    priceCents: t.price_cents,
    currency: t.currency,
    maxPerOrder: t.max_per_order,
    available: t.available,
    total: t.total,
  };
}

async function loadPublicConcert(concertId: string) {
  const concert = await repo.findPublicConcert(pool, concertId);
  if (!concert) {
    throw new HttpError(404, 'not_found', 'Concert not found');
  }
  return concert;
}

export async function listConcerts(filters: ListConcertsQuery) {
  const rows = await repo.listPublicConcerts(pool, filters);
  return { concerts: rows.map(toConcertSummaryDto), limit: filters.limit, offset: filters.offset };
}

export async function getConcert(concertId: string) {
  const concert = await loadPublicConcert(concertId);
  const ticketTypes = await repo.listPublicTicketTypes(pool, concertId);
  return { ...toConcertDetailDto(concert), ticketTypes: ticketTypes.map(toTicketTypeDto) };
}

interface SeatMapSection {
  id: string;
  name: string;
  rows: { id: string; label: string; seats: { id: string; seatNumber: string; ticketTypeId: string; status: PublicSeatStatus }[] }[];
}

/** Nests the flat, already-ordered seat rows into sections -> rows -> seats. */
export async function getSeatMap(concertId: string) {
  await loadPublicConcert(concertId);
  const seats = await repo.listSeatMap(pool, concertId);

  const sections: SeatMapSection[] = [];
  for (const s of seats) {
    let section = sections.at(-1);
    if (section?.id !== s.section_id) {
      section = { id: s.section_id, name: s.section_name, rows: [] };
      sections.push(section);
    }
    let row = section.rows.at(-1);
    if (row?.id !== s.row_id) {
      row = { id: s.row_id, label: s.row_label, seats: [] };
      section.rows.push(row);
    }
    row.seats.push({ id: s.seat_id, seatNumber: s.seat_number, ticketTypeId: s.ticket_type_id, status: s.status });
  }
  return { concertId, sections };
}
