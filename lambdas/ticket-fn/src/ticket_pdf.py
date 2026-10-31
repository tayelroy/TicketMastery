"""E-ticket PDF: one A4 page per seat.

A tiny PDF writer using only the built-in Helvetica fonts, so the Lambda zip is just this folder (no layers or
third-party packages). The output has no timestamps, so a retried message renders the same bytes.
"""

from datetime import datetime, timedelta, timezone

PAGE_W, PAGE_H = 595, 842  # A4 in points
MARGIN = 50

# Venues are in Singapore (prices are SGD). A fixed offset, because Lambda's Python has no tz database.
SGT = timezone(timedelta(hours=8), "SGT")

NAVY = (0.11, 0.16, 0.33)
GREY = (0.42, 0.45, 0.5)
LIGHT = (0.93, 0.94, 0.96)
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)


def format_money(cents, currency):
    return f"{currency} {cents / 100:,.2f}"


def format_start(iso):
    """'2026-12-23T11:40:00.000Z' -> 'Wed 23 Dec 2026, 7:40 PM SGT'."""
    starts = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(SGT)
    hour = starts.hour % 12 or 12
    return f"{starts:%a} {starts.day} {starts:%b %Y}, {hour}:{starts:%M} {'AM' if starts.hour < 12 else 'PM'} SGT"


def _escape(text):
    # Standard fonts only cover Latin-1; anything else becomes '?' rather than breaking the PDF.
    text = str(text).encode("latin-1", "replace").decode("latin-1")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _fit(text, size, width=PAGE_W - 2 * MARGIN):
    """Largest font size <= size that fits text in width, assuming an average Helvetica glyph of 0.55 em."""
    return min(size, width / (0.55 * max(len(str(text)), 1)))


def _rgb(colour):
    return " ".join(f"{c:g}" for c in colour)


class Page:
    """Drawing operations for one page. Coordinates are in points from the bottom-left corner."""

    def __init__(self):
        self.ops = []

    def rect(self, x, y, w, h, colour):
        self.ops.append(f"{_rgb(colour)} rg {x:g} {y:g} {w:g} {h:g} re f")

    def text(self, x, y, text, size=12, bold=False, colour=BLACK):
        font = "F2" if bold else "F1"
        self.ops.append(f"BT {_rgb(colour)} rg /{font} {size:g} Tf {x:g} {y:g} Td ({_escape(text)}) Tj ET")

    def content(self):
        return "\n".join(self.ops).encode("latin-1")


def build_pdf(pages, title):
    """Serialises pages into a PDF file (catalog, page tree, two fonts, then a page + content stream per page)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        None,  # page tree, filled in once the page object numbers are known
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        f"<< /Title ({_escape(title)}) /Producer (TicketMastery ticket-fn) >>".encode("latin-1"),
    ]
    page_ids = []
    for page in pages:
        stream = page.content()
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content_id = len(objects)
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R >>".encode("latin-1")
        )
        page_ids.append(len(objects))
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("latin-1")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info 5 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref_at)
    return bytes(out)


def _ticket_page(event, seat, number, count):
    concert = event["concert"]
    page = Page()

    # Header band
    page.rect(0, PAGE_H - 150, PAGE_W, 150, NAVY)
    page.text(MARGIN, PAGE_H - 55, "TICKETMASTERY  E-TICKET", size=11, bold=True, colour=WHITE)
    page.text(MARGIN, PAGE_H - 95, concert["title"], size=_fit(concert["title"], 26), bold=True, colour=WHITE)
    page.text(MARGIN, PAGE_H - 125, concert["artist"], size=16, colour=WHITE)

    # When and where
    y = PAGE_H - 200
    page.text(MARGIN, y, "DATE & TIME", size=9, bold=True, colour=GREY)
    page.text(MARGIN, y - 20, format_start(concert["startsAt"]), size=14)
    page.text(MARGIN, y - 60, "VENUE", size=9, bold=True, colour=GREY)
    page.text(MARGIN, y - 80, concert["venueName"], size=14)

    # Seat box
    box_top = y - 120
    page.rect(MARGIN, box_top - 130, PAGE_W - 2 * MARGIN, 130, LIGHT)
    columns = [("SECTION", seat["section"]), ("ROW", seat["row"]), ("SEAT", seat["seatNumber"])]
    for i, (label, value) in enumerate(columns):
        x = MARGIN + 20 + i * 165
        page.text(x, box_top - 35, label, size=9, bold=True, colour=GREY)
        page.text(x, box_top - 75, value, size=_fit(value, 30, width=150), bold=True, colour=NAVY)
    page.text(MARGIN + 20, box_top - 110, seat["ticketType"], size=12, bold=True)
    page.text(MARGIN + 330, box_top - 110, format_money(seat["priceCents"], event["currency"]), size=12)

    # Identifiers for entry
    y = box_top - 180
    page.text(MARGIN, y, "TICKET ID", size=9, bold=True, colour=GREY)
    page.text(MARGIN, y - 18, seat["seatId"], size=11)
    page.text(MARGIN, y - 50, "ORDER", size=9, bold=True, colour=GREY)
    page.text(MARGIN, y - 68, event["orderId"], size=11)
    page.text(MARGIN, y - 100, f"Ticket {number} of {count}", size=11, colour=GREY)

    # Footer
    page.text(MARGIN, 70, "Show this page (printed or on your phone) at the entrance. One entry per ticket.", size=9, colour=GREY)
    page.text(MARGIN, 55, "This ticket is non-transferable. Do not share the ticket ID.", size=9, colour=GREY)
    return page


def _summary_page(event):
    page = Page()
    concert = event["concert"]
    currency = event["currency"]
    page.rect(0, PAGE_H - 110, PAGE_W, 110, NAVY)
    page.text(MARGIN, PAGE_H - 55, "TICKETMASTERY  ORDER SUMMARY", size=11, bold=True, colour=WHITE)
    page.text(MARGIN, PAGE_H - 88, concert["title"], size=_fit(concert["title"], 20), bold=True, colour=WHITE)

    y = PAGE_H - 150
    page.text(MARGIN, y, f"Order {event['orderId']}", size=11, colour=GREY)
    page.text(MARGIN, y - 18, f"{concert['venueName']}  |  {format_start(concert['startsAt'])}", size=11, colour=GREY)

    y -= 60
    page.text(MARGIN, y, "SEAT", size=9, bold=True, colour=GREY)
    page.text(MARGIN + 250, y, "TICKET TYPE", size=9, bold=True, colour=GREY)
    page.text(PAGE_W - MARGIN - 90, y, "PRICE", size=9, bold=True, colour=GREY)
    for seat in event["seats"]:
        y -= 22
        page.text(MARGIN, y, f"{seat['section']}  Row {seat['row']}  Seat {seat['seatNumber']}", size=11)
        page.text(MARGIN + 250, y, seat["ticketType"], size=11)
        page.text(PAGE_W - MARGIN - 90, y, format_money(seat["priceCents"], currency), size=11)

    y -= 40
    for label, cents, bold in [
        ("Subtotal", event["subtotalCents"], False),
        ("Booking fee", event["bookingFeeCents"], False),
        ("Total paid", event["totalCents"], True),
    ]:
        page.text(MARGIN + 250, y, label, size=11, bold=bold)
        page.text(PAGE_W - MARGIN - 90, y, format_money(cents, currency), size=11, bold=bold)
        y -= 20
    return page


def render_tickets(event):
    """OrderConfirmed event -> PDF bytes: an order summary, then one ticket page per seat."""
    seats = event["seats"]
    pages = [_summary_page(event)]
    pages += [_ticket_page(event, seat, i, len(seats)) for i, seat in enumerate(seats, start=1)]
    return build_pdf(pages, f"E-tickets {event['concert']['title']} {event['orderId']}")
