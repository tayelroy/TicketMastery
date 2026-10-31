# pages/account — UC2 My Tickets & Account

**Owner:** Andrew
**Calls:** `/api/me` (API module `services/ticketmastery-api/src/modules/account/`) and Cognito (profile)
**Status:** implemented. E-ticket downloads say "not ready yet" until UC4's PDF bucket exists (the API answers `503`).

## Routes

All signed in (`RequireAuth`).

- `/myaccount`: my tickets, split into **Upcoming** (soonest first) and **Past** (most recent first), plus the
  profile card. A ticket for a concert the organiser cancelled shows a "Concert cancelled" badge.
- `/myaccount/tickets`: redirects to `/myaccount` (the checkout confirmation links here).
- `/myaccount/tickets/:ticketId`: one e-ticket: concert, date and time, venue, order number, each seat with its
  ticket type and price, booking fee and total, and **Download e-ticket (PDF)**. `ticketId` is the order id (one
  e-ticket per order).

## API endpoints used

- `GET /api/me/orders`: my confirmed orders (`types.ts` mirrors the response)
- `GET /api/me/tickets/:id`: one order; `404` for an unknown order or someone else's
- `GET /api/me/tickets/:id/download`: `{ url }`, a 5-minute pre-signed S3 link; the page navigates to it and the PDF
  downloads as an attachment

## Profile

`ProfileCard.tsx` reads and updates the user's Cognito attributes in the browser with Amplify
(`fetchUserAttributes`, `updateUserAttributes`): the display name (`name`) is editable, the email (the sign-in name)
is read-only. The API stores no profile. With the fake login (`VITE_AUTH_MODE=dev-header`) the card only shows a note.

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
