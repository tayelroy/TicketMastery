# account module — UC2 My Tickets & Account

**Owner:** Andrew
**Mounted at:** `/api/me` (registered in `src/modules/index.ts`)
**Status:** implemented. E-ticket downloads answer `503` until UC4's PDF bucket exists (see [Configuration](#configuration)).

## Endpoints

All routes need a signed-in user (any group): `401 unauthenticated` when anonymous. API Gateway's JWT authorizer
checks the token first (`ANY /api/me`, `ANY /api/me/{proxy+}`), and the API checks it again. Every response is
`Cache-Control: no-store`.

| Route | Returns |
|---|---|
| `GET /api/me` | `{ sub, groups }` from the verified access token. The email is in the ID token, which the browser already has. |
| `GET /api/me/orders` | `{ orders: Order[] }`: the caller's **confirmed** orders, newest first, at most 100 |
| `GET /api/me/tickets/:ticketId` | one `Order` |
| `GET /api/me/tickets/:ticketId/download` | `{ url, expiresInSeconds: 300 }`: a pre-signed S3 link to the e-ticket PDF |

A ticket is an order: ticket-fn renders one PDF per `OrderConfirmed`, so `ticketId` is the order id.

```json
{
  "orderId": "…",
  "confirmedAt": "2026-11-02T09:15:00.000Z",
  "currency": "SGD",
  "subtotalCents": 35000,
  "bookingFeeCents": 800,
  "totalCents": 35800,
  "concert": {
    "id": "…", "title": "…", "artist": "…", "venueName": "…", "startsAt": "…", "imageUrl": null,
    "status": "scheduled"
  },
  "seats": [{ "section": "Floor", "row": "A", "seatNumber": "1", "ticketType": "VIP", "priceCents": 25000 }]
}
```

- Field names follow UC4's `OrderConfirmed` event. Seats are in seat-map order (section, row, seat), with numeric
  seat numbers sorted as numbers (2 before 10), like discovery's seat map.
- `pending`, `cancelled` and `expired` orders are checkout attempts that never became tickets, so they are left out.
- `concert.status` is the concert's current status: an organiser can cancel a concert after tickets were sold, and
  the order stays `confirmed` (UC5's `ConcertCancelled` event is still a TODO).

| Status | `error.code` | When |
|---|---|---|
| 400 | `validation_error` | `ticketId` isn't a uuid |
| 404 | `not_found` | no confirmed order with that id belongs to the caller (also for someone else's order, so ids can't be probed) |
| 409 | `ticket_not_ready` | download only: ticket-fn hasn't written the PDF yet |
| 503 | `not_configured` | download only: `TICKET_PDF_BUCKET` is unset |

### Download link

The API first checks that ticket-fn has written `tickets/<orderId>.pdf` (`HeadObject`): right after a purchase, or
while the order event waits in the DLQ, it hasn't, and the API answers `409 ticket_not_ready` instead of a link that
would land the fan on S3's XML error page. Then it signs a `GetObject` URL, valid 5 minutes, served as an attachment
(`ticketmastery-<orderId>.pdf`); the browser downloads straight from the private bucket.

S3 answers `HeadObject` on a missing object with `404` only if the caller may list the bucket. With `s3:GetObject`
alone it answers `403`, which the API treats as a failure (`500`, logged), so the grant below includes
`s3:ListBucket`.

## Configuration

| Variable | From |
|---|---|
| `TICKET_PDF_BUCKET` | UC4's e-ticket bucket (Shi Hui's `infra/modules/messaging`), via `extra_environment`. Unset: downloads `503`. |

Agreed with UC4: one PDF per order at `tickets/<orderId>.pdf` (also noted in `lambdas/README.md`), and the bucket's
module grants the API task role `s3:GetObject` on `tickets/*` and `s3:ListBucket` on the bucket (the same pattern as
`messaging`'s `sns:Publish` and `waiting-room`'s DynamoDB grant).
The variable is read in `service.ts`, not `src/config.ts`, like UC3/UC4's AWS settings.

## Code

`router.ts` (sign-in + zod parsing), `service.ts` (404s, DTO, PDF check, signing), `repository.ts` (one SQL query for the list
and the detail, always filtered by `fan_id` = the token's `sub`), `schemas.ts` (zod).

## Tests

- `test/account-http.test.ts` (no database): sign-in on every route, `GET /api/me`, ticket id validation, `503`
  without a bucket, the signed link (offline, fake credentials), and the order routes on canned rows (`pool.query`
  mocked: DTO mapping, the token's `sub` as the only filter value, `404`).
- `test/account-download.test.ts` (no database, no AWS): with a bucket set, the `HeadObject` check: link when the PDF
  exists, `409` when S3 says `NotFound`, `500` on any other S3 error, and no S3 call for an order that isn't yours.
- `test/account.test.ts` (Postgres): orders made through the real UC5 and UC4 services; two fans each see only their
  own; unconfirmed orders are hidden; newest first; seat order; a cancelled concert; the 100-order cap; downloads.
- All run in `npm run test:coverage`, which fails below 100% for this module, with or without a database.
