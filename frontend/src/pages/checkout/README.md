# pages/checkout — UC4 Seat selection & checkout

**Owner:** Shi Hui
**Calls:** `/api/checkout` (API module `services/ticketmastery-api/src/modules/checkout/`)
**Status:** implemented (seat selection, checkout with a 10-minute reservation timer, simulated payment, confirmation).

## Routes

- `/concerts/:concertId/checkout`: select seats, check out, pay, confirmation (signed in)

## API endpoints (details in the API module README)

- `GET /api/checkout/concerts/:concertId/seats`: concert, ticket types, seats with availability, the fan's active hold
- `POST /api/checkout/holds`: hold seats for 10 minutes
- `DELETE /api/checkout/holds/:holdId`: release a hold
- `POST /api/checkout/holds/:holdId/confirm`: simulated payment (`simulatePaymentFailure` for the demo checkbox)

## Keeping the seat map fresh

- The map is fetched on arrival and again after anything that changes it (checkout, change seats, timeout, errors).
- A seat click refreshes it first when it is more than 20 seconds old (`STALE_SEAT_MAP_MS`), keeping the fan's
  selection. A seat taken meanwhile is not selected, and already-selected seats that were taken are removed, with a
  message. Clicks within 20 seconds of the last refresh don't refresh again, so picking several seats stays quick.
- Checkout still checks every seat on the server (`seats_unavailable`), which covers anything taken inside the window.

## Files

- `CheckoutPage.tsx`: the page in three steps: Select seats → Checkout (10-minute reservation timer, itemised order summary, simulated payment; "Change seats" releases them) → Confirmation. The API calls the reservation a "hold". When the 10 minutes run out, the page releases the reservation, shows the seat map again and opens a "Reservation timed out" popup that the fan closes themselves (`TimeoutDialog`).
- `types.ts`: API response types and money/date formatting
- `checkout.css`: styles (ticket type colours `tt-0`…`tt-3`, seat states)

## Trying it locally

The demo concert's sale opens 30 days after seeding. To buy from it locally, publish it and move its sale start:

```bash
# API running (docker compose up) and seeded; <id> from the seed log
curl -X POST -H 'x-dev-user-id: org-1' -H 'x-dev-user-groups: organisers' localhost:3000/api/organiser/concerts/<id>/publish
docker compose exec postgres psql -U tm -d ticketmastery -c "UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = '<id>'"
```

Then sign in with any user id and open `/concerts/<id>/checkout`.

To see the timeout popup without waiting 10 minutes, reserve seats, shorten the reservation, then refresh the page:

```bash
docker compose exec postgres psql -U tm -d ticketmastery -c "UPDATE orders SET expires_at = now() + interval '20 seconds' WHERE status = 'pending'" -c "UPDATE seats SET hold_expires_at = now() + interval '20 seconds' WHERE status = 'held'"
```

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
