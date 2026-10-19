/** One e-ticket as the My Tickets pages show it. Field names are a guess until GET /api/me/orders is built. */
export interface TicketView {
  id: string;
  concertTitle: string;
  subtitle: string;
  startsAt: string;
  venueName: string;
  seat: string;
  imageUrl: string | null;
}

/**
 * SAMPLE DATA ONLY, shown while GET /api/me/orders is a 501 stub so the design can be seen.
 * Andrew: replace with the real API response and delete this file.
 */
export const SAMPLE_TICKETS: TicketView[] = [
  {
    id: 'sample-1',
    concertTitle: 'Sample Concert',
    subtitle: 'Live in Singapore',
    startsAt: '2026-12-19T14:00:00Z',
    venueName: 'Singapore Indoor Stadium',
    seat: 'CAT1 · Row A · Seat 12',
    imageUrl: null,
  },
];

export function formatTicketDate(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase(),
    time: d.toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit' }).toUpperCase(),
  };
}
