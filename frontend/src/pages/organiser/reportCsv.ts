import type { SalesReport } from './types';

/**
 * CSV export of the sales report, built in the browser from the JSON the page already loaded.
 * Pure functions only (no DOM), so the rules are easy to check: RFC 4180 quoting, CRLF line ends,
 * money as a plain decimal with two places (no currency symbol, no thousands separator) next to a currency column.
 */

export type CsvValue = string | number | null;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/** Quotes a cell when it holds a comma, quote, CR or LF; quotes inside are doubled. null is an empty cell. */
export function escapeCsvCell(value: CsvValue): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Integer cents -> "1234.50" (exact, no floating point). */
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function buildCsv<T>(columns: CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map((c) => escapeCsvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCsvCell(c.value(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** `ticketmastery-<section>-<days>d-<to>.csv`; all time is `-all-`. */
export function csvFilename(section: ReportSection, days: number | null, to: string): string {
  return `ticketmastery-${section}-${days === null ? 'all' : `${days}d`}-${to}.csv`;
}

type ReportList = Exclude<keyof SalesReport, 'range' | 'concertId'>;

/** One downloadable section: which array of the report, and its columns. */
function csvSection<K extends ReportList>(key: K, columns: CsvColumn<SalesReport[K][number]>[]) {
  return (report: SalesReport) => buildCsv(columns, report[key]);
}

/** Report section (the file name part) -> its CSV text from a loaded report. */
export const CSV_SECTIONS = {
  summary: csvSection('totals', [
    { header: 'currency', value: (r) => r.currency },
    { header: 'orders', value: (r) => r.confirmedOrders },
    { header: 'tickets_sold', value: (r) => r.seatsSold },
    { header: 'ticket_revenue', value: (r) => centsToDecimal(r.ticketRevenueCents) },
    { header: 'booking_fees', value: (r) => centsToDecimal(r.bookingFeeCents) },
    { header: 'gross_revenue', value: (r) => centsToDecimal(r.grossRevenueCents) },
    { header: 'average_order', value: (r) => centsToDecimal(r.averageOrderCents) },
  ]),
  'by-day': csvSection('byDay', [
    { header: 'date_sgt', value: (r) => r.date },
    { header: 'currency', value: (r) => r.currency },
    { header: 'orders', value: (r) => r.confirmedOrders },
    { header: 'tickets_sold', value: (r) => r.seatsSold },
    { header: 'gross_revenue', value: (r) => centsToDecimal(r.grossRevenueCents) },
  ]),
  'by-concert': csvSection('byConcert', [
    { header: 'concert_id', value: (r) => r.concertId },
    { header: 'concert', value: (r) => r.title },
    { header: 'artist', value: (r) => r.artist },
    { header: 'venue', value: (r) => r.venueName },
    { header: 'starts_at', value: (r) => r.startsAt },
    { header: 'status', value: (r) => r.status },
    { header: 'currency', value: (r) => r.currency },
    { header: 'orders', value: (r) => r.confirmedOrders },
    { header: 'tickets_sold', value: (r) => r.seatsSold },
    { header: 'ticket_revenue', value: (r) => centsToDecimal(r.ticketRevenueCents) },
    { header: 'booking_fees', value: (r) => centsToDecimal(r.bookingFeeCents) },
    { header: 'gross_revenue', value: (r) => centsToDecimal(r.grossRevenueCents) },
  ]),
  'ticket-types': csvSection('byTicketType', [
    { header: 'concert_id', value: (r) => r.concertId },
    { header: 'concert', value: (r) => r.concertTitle },
    { header: 'ticket_type', value: (r) => r.ticketTypeName },
    { header: 'currency', value: (r) => r.currency },
    { header: 'orders', value: (r) => r.confirmedOrders },
    { header: 'tickets_sold', value: (r) => r.seatsSold },
    { header: 'ticket_revenue', value: (r) => centsToDecimal(r.ticketRevenueCents) },
  ]),
  'seat-status': csvSection('seatStatus', [
    { header: 'concert_id', value: (r) => r.concertId },
    { header: 'concert', value: (r) => r.title },
    { header: 'starts_at', value: (r) => r.startsAt },
    { header: 'status', value: (r) => r.status },
    { header: 'available', value: (r) => r.available },
    { header: 'held', value: (r) => r.held },
    { header: 'sold', value: (r) => r.sold },
    { header: 'total', value: (r) => r.total },
    { header: 'percent_sold', value: (r) => (r.total === 0 ? null : ((r.sold / r.total) * 100).toFixed(1)) },
  ]),
  'recent-orders': csvSection('recentOrders', [
    { header: 'order_id', value: (r) => r.orderId },
    { header: 'concert_id', value: (r) => r.concertId },
    { header: 'concert', value: (r) => r.concertTitle },
    { header: 'seats', value: (r) => r.seats },
    { header: 'currency', value: (r) => r.currency },
    { header: 'total', value: (r) => centsToDecimal(r.grossRevenueCents) },
    { header: 'confirmed_at', value: (r) => r.confirmedAt },
  ]),
};

export type ReportSection = keyof typeof CSV_SECTIONS;
