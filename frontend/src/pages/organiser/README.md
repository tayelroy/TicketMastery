# pages/organiser — UC5 Concert & ticket management

**Owner:** Elroy (API) · page built by Nai Xin
**Calls:** `/api/organiser` (API module `services/ticketmastery-api/src/modules/organiser/`)
**Status:** built against the real API, signed in with the dev login (Cognito later; no page changes needed).

## Routes

- `/organiser`: my concerts + "New concert" form (creates a draft)
- `/organiser/concerts/:concertId`: manage one concert
  - draft: checklist, then **Publish** once every ticket type's seat count equals its quantity
  - ticket types editor and seat layout editor while the layout is unlocked (the layout editor starts from
    a layout generated from the ticket types, 20 seats per row, and shows a live seats-vs-quantity tally)
  - read-only ticket types and layout once the sale has started (`layoutLocked`)
  - live sales dashboard (refreshes every 5s) once published
  - cancel with a reason (any status except cancelled/completed)

Both routes need the `organisers` group (`RequireAuth`). Locally (fake login): sign in at `/login` and tick
"Organiser". With Cognito: an admin adds the account to the `organisers` group, then sign out and sign in again.

## API endpoints used

`GET/POST /concerts`, `GET /concerts/:id`, `PUT /concerts/:id/ticket-types`, `PUT /concerts/:id/layout`,
`POST /concerts/:id/publish`, `POST /concerts/:id/cancel`, `GET /concerts/:id/dashboard`. Response shapes are in
`types.ts`; API errors (validation, layout/quantity mismatches) are shown by `ErrorNotice`.

## Notes

- Keep everything for this feature inside this folder, including `routes.tsx`, which `src/features.ts` already registers. Ask Nai Xin before changing shared files (`src/app/`, `src/api/`, `src/auth/`, `src/features.ts`, `src/router.tsx`).
- Call the backend only through `api()` from `src/api/client.ts`. It adds the base URL and the auth headers.
- Never read or set the `x-dev-user-*` headers yourself. Use `useAuth()` from `src/auth/AuthContext.tsx` to read the signed-in user.
- The API only returns per-section summaries of a saved layout, so the layout editor cannot reload the exact
  rows; saving always replaces the whole layout.
- No edit endpoint for concert details (title, dates, image) yet, so those are set only when creating.
