import { GetObjectCommand, HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AuthUser } from '../../auth';
import { pool } from '../../db/pool';
import { HttpError } from '../../http/errors';
import * as repo from './repository';
import type { MyOrderRow } from './repository';

/**
 * Private bucket with the e-ticket PDFs, written by UC4's ticket-fn (Shi Hui), whose module also grants the API
 * s3:GetObject on tickets/* and passes the name to the ECS task through extra_environment. Read here rather than in
 * src/config.ts, like UC3/UC4's AWS settings, so UC2 doesn't change shared code. Unset (local dev, or until the
 * bucket exists): downloads answer 503.
 */
const TICKET_PDF_BUCKET = process.env.TICKET_PDF_BUCKET?.trim() || undefined;

/** Download links live 5 minutes (and never longer than the task role's current credentials). */
export const DOWNLOAD_URL_TTL_SECONDS = 300;

// Region and credentials come from the ECS task (AWS_REGION + task role), so nothing is configured here.
const s3 = new S3Client({});

/** Object key agreed with ticket-fn: one PDF per order. */
export const ticketPdfKey = (orderId: string) => `tickets/${orderId}.pdf`;

const ticketNotFound = () => new HttpError(404, 'not_found', 'Ticket not found');

function toOrderDto(o: MyOrderRow) {
  return {
    orderId: o.id,
    confirmedAt: o.confirmed_at,
    currency: o.currency,
    subtotalCents: o.subtotal_cents,
    bookingFeeCents: o.booking_fee_cents,
    totalCents: o.total_cents,
    concert: {
      id: o.concert_id,
      title: o.title,
      artist: o.artist,
      venueName: o.venue_name,
      startsAt: o.starts_at,
      imageUrl: o.image_url,
      status: o.concert_status,
    },
    seats: o.seats,
  };
}

/** GET /api/me: who the token says the caller is. The email is in the ID token, which the browser already has. */
export function getMe(user: AuthUser) {
  return { sub: user.sub, groups: user.groups };
}

/** GET /api/me/orders */
export async function listMyOrders(fanId: string) {
  return (await repo.listMyOrders(pool, fanId)).map(toOrderDto);
}

/** GET /api/me/tickets/:ticketId. 404 (not 403) for someone else's order, so order ids can't be probed. */
export async function getMyTicket(fanId: string, orderId: string) {
  const order = await repo.findMyOrder(pool, fanId, orderId);
  if (!order) throw ticketNotFound();
  return toOrderDto(order);
}

/**
 * GET /api/me/tickets/:ticketId/download: a pre-signed link, so the browser downloads the PDF straight from the
 * private bucket. First checks that ticket-fn has written the PDF (right after purchase, or while the order event sits
 * in the DLQ, it hasn't): a link to a missing object would land the fan on S3's XML error page, outside the app.
 */
export async function ticketDownloadUrl(fanId: string, orderId: string) {
  if (!TICKET_PDF_BUCKET) {
    throw new HttpError(503, 'not_configured', 'E-ticket downloads are not available yet');
  }
  if (!(await repo.findMyOrder(pool, fanId, orderId))) throw ticketNotFound();
  await assertTicketPdfExists(TICKET_PDF_BUCKET, orderId);
  return presignTicketDownload(TICKET_PDF_BUCKET, orderId);
}

/**
 * S3 answers a missing object with 404 only if the caller may list the bucket (s3:ListBucket, granted with the
 * bucket); with s3:GetObject alone it answers 403, which is rethrown here like any other failure (500, logged).
 */
async function assertTicketPdfExists(bucket: string, orderId: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: ticketPdfKey(orderId) }));
  } catch (err) {
    if (err instanceof NotFound) {
      throw new HttpError(409, 'ticket_not_ready', 'Your e-ticket is still being prepared');
    }
    throw err;
  }
}

/** Signing is a local computation: no call to S3 happens here. */
export async function presignTicketDownload(bucket: string, orderId: string) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: ticketPdfKey(orderId),
      ResponseContentDisposition: `attachment; filename="ticketmastery-${orderId}.pdf"`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
  return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS };
}
