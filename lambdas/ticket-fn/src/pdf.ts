import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';
import qrcode from 'qrcode/lib/core/qrcode.js';
import type { OrderConfirmedEvent } from './event.js';
import { formatMoney, formatSgt } from './format.js';

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const BRAND = rgb(0.16, 0.12, 0.42);
const RULE = rgb(0.82, 0.82, 0.86);

/**
 * The standard PDF fonts only cover WinAnsi (Latin-1 plus a few symbols) and pdf-lib throws on anything else, so an
 * artist name in CJK script would fail the whole ticket. Those characters print as "?" instead; embedding a Unicode
 * font would add megabytes to the bundle for a one-page ticket.
 */
function safeText(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  return Array.from(text.replace(/[\u00a0\u2009\u202f]/g, ' '))
    .map((ch) => (supported.has(ch.codePointAt(0) ?? 0) ? ch : '?'))
    .join('');
}

/** Cuts text to maxWidth with "..." so a long concert title can't run off the page. */
function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  let out = safeText(font, text);
  if (font.widthOfTextAtSize(out, size) <= maxWidth) return out;
  while (out.length > 0 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}

/** Draws the QR modules as filled squares (runs of dark modules merged), so no image codec is needed. */
function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const { modules } = qrcode.create(text, { errorCorrectionLevel: 'M' });
  const quiet = 4; // the spec's minimum quiet zone, in modules
  const cell = size / (modules.size + 2 * quiet);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let row = 0; row < modules.size; row++) {
    let col = 0;
    while (col < modules.size) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < modules.size && modules.get(row, col)) col++;
      page.drawRectangle({
        x: x + (quiet + start) * cell,
        y: y + size - (quiet + row + 1) * cell,
        width: (col - start) * cell,
        height: cell,
        color: rgb(0, 0, 0),
      });
    }
  }
}

/** One A4 page: concert, order id + QR code, a line per seat, and the totals. Checkout caps an order at 3 seats. */
export async function renderTicketPdf(event: OrderConfirmedEvent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Fixed dates make a retry render the same document as the first attempt.
  const issued = new Date(event.occurredAt);
  if (!Number.isNaN(issued.getTime())) {
    doc.setCreationDate(issued);
    doc.setModificationDate(issued);
  }
  doc.setTitle(`TicketMastery e-ticket ${event.orderId}`);
  doc.setAuthor('TicketMastery');
  doc.setProducer('TicketMastery ticket-fn');
  doc.setCreator('TicketMastery ticket-fn');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(A4);
  const [width, height] = A4;
  const contentWidth = width - 2 * MARGIN;

  // Header band
  page.drawRectangle({ x: 0, y: height - 72, width, height: 72, color: BRAND });
  page.drawText('TicketMastery', { x: MARGIN, y: height - 46, size: 22, font: bold, color: rgb(1, 1, 1) });
  const label = 'E-TICKET';
  page.drawText(label, {
    x: width - MARGIN - bold.widthOfTextAtSize(label, 12),
    y: height - 42,
    size: 12,
    font: bold,
    color: rgb(1, 1, 1),
  });

  // Concert details on the left, QR code on the right
  const qrSize = 132;
  const textWidth = contentWidth - qrSize - 16;
  let y = height - 112;
  page.drawText(fit(bold, event.concert.title, 20, textWidth), { x: MARGIN, y, size: 20, font: bold, color: INK });
  y -= 24;
  page.drawText(fit(regular, event.concert.artist, 13, textWidth), {
    x: MARGIN,
    y,
    size: 13,
    font: regular,
    color: INK,
  });
  y -= 30;
  const details: [string, string][] = [
    ['Venue', event.concert.venueName],
    ['Starts', formatSgt(event.concert.startsAt)],
    ['Order', event.orderId],
  ];
  for (const [name, value] of details) {
    page.drawText(name.toUpperCase(), { x: MARGIN, y, size: 8, font: bold, color: MUTED });
    page.drawText(fit(regular, value, 11, textWidth - 60), { x: MARGIN + 60, y, size: 11, font: regular, color: INK });
    y -= 20;
  }
  drawQr(page, event.orderId, width - MARGIN - qrSize, height - 92 - qrSize, qrSize);
  page.drawText('Scan at the entrance', {
    x: width - MARGIN - qrSize / 2 - regular.widthOfTextAtSize('Scan at the entrance', 8) / 2,
    y: height - 104 - qrSize,
    size: 8,
    font: regular,
    color: MUTED,
  });

  // Seats table
  y = height - 290;
  const columns = [
    { title: 'Section', x: MARGIN, width: 130 },
    { title: 'Row', x: MARGIN + 140, width: 50 },
    { title: 'Seat', x: MARGIN + 200, width: 50 },
    { title: 'Ticket type', x: MARGIN + 260, width: 150 },
  ];
  const priceRight = width - MARGIN;
  for (const c of columns) page.drawText(c.title.toUpperCase(), { x: c.x, y, size: 8, font: bold, color: MUTED });
  page.drawText('PRICE', { x: priceRight - bold.widthOfTextAtSize('PRICE', 8), y, size: 8, font: bold, color: MUTED });
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: priceRight, y }, thickness: 0.75, color: RULE });
  y -= 16;
  for (const seat of event.seats) {
    const cells = [seat.section, seat.row, seat.seatNumber, seat.ticketType];
    cells.forEach((value, i) => {
      const c = columns[i]!;
      page.drawText(fit(regular, value, 10, c.width), { x: c.x, y, size: 10, font: regular, color: INK });
    });
    const price = formatMoney(seat.priceCents, event.currency);
    page.drawText(price, {
      x: priceRight - regular.widthOfTextAtSize(price, 10),
      y,
      size: 10,
      font: regular,
      color: INK,
    });
    y -= 18;
  }
  y += 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: priceRight, y }, thickness: 0.75, color: RULE });
  y -= 18;

  // Totals
  const totals: [string, number, PDFFont][] = [
    ['Subtotal', event.subtotalCents, regular],
    ['Booking fee', event.bookingFeeCents, regular],
    ['Total paid', event.totalCents, bold],
  ];
  for (const [name, cents, font] of totals) {
    const value = formatMoney(cents, event.currency);
    page.drawText(name, { x: priceRight - 200, y, size: 11, font, color: INK });
    page.drawText(value, { x: priceRight - font.widthOfTextAtSize(value, 11), y, size: 11, font, color: INK });
    y -= 18;
  }

  const footer =
    'One entry per seat. Bring this ticket (printed or on your phone). Also available under My Tickets on TicketMastery.';
  page.drawText(fit(regular, footer, 8, contentWidth), { x: MARGIN, y: MARGIN, size: 8, font: regular, color: MUTED });

  return doc.save();
}
