# frontend/

The TicketMastery web app: **Vite + React + TypeScript** with React Router. It is served from S3 behind CloudFront and calls the API under `/api/...`.

**Contents:** [Quick start](#quick-start) · [Pages](#pages) · [Building your feature](#building-your-feature) · [Styling](#styling) · [Login](#login) · [Configuration](#configuration) · [Deploying](#deploying)

## Quick start

Needs Node 20.19+ and Docker.

```bash
# Terminal 1: API + database
cd services/ticketmastery-api
docker compose up --build
docker compose run --rm api node dist/db/seed.js   # optional: demo concert for org-1

# Terminal 2: frontend
cd frontend
npm ci
npm run dev                                        # open http://localhost:5173
```

The footer shows **API ok** when the frontend can reach the API. No `.env` setup is needed for local dev.

Only open port **5173** in the browser. Port 3000 is the API and only returns JSON.

`npm run build` typechecks and builds to `dist/`.

## Pages

| URL | Page | Notes |
|---|---|---|
| http://localhost:5173/ | Concert discovery (UC1) | public |
| http://localhost:5173/concerts/123 | Concert detail (UC1) | public; any ID works for now |
| http://localhost:5173/concerts/123/waiting-room | Waiting room (UC3) | public |
| http://localhost:5173/concerts/123/checkout | Checkout (UC4) | sign in |
| http://localhost:5173/myaccount | My Tickets (UC2) | sign in |
| http://localhost:5173/myaccount/tickets/sample-1 | One e-ticket (UC2) | sign in; sample data |
| http://localhost:5173/organiser | Organiser dashboard (UC5) | sign in as `org-1` with "Organiser" ticked |
| http://localhost:5173/login | Fake login | any user ID, no password |

Pages marked "sign in" send you to `/login` first.

## Building your feature

Each use case has one folder under `src/pages/`:

| Folder | Use case | Calls | Owner |
|---|---|---|---|
| `discovery/` | UC1 Concert discovery | `/api/concerts` | Cody & Nai Xin |
| `account/` | UC2 My Tickets & Account | `/api/me` | Andrew |
| `waiting-room/` | UC3 Virtual waiting room | `/api/waiting-room` | Yan Ting |
| `checkout/` | UC4 Seat selection & checkout | `/api/checkout` | Shi Hui |
| `organiser/` | UC5 Concert & ticket management | `/api/organiser` | Elroy |

Each folder has a `routes.tsx` (its URLs and nav links), its `*Page.tsx` files, optional CSS, and a `README.md` listing its endpoints.

**Rules**

1. Work only inside your own folder. Add routes in its `routes.tsx`; they are already registered.
2. Call the backend only through `api()` from `src/api/client.ts`:
   ```ts
   const { concerts } = await api<{ concerts: Concert[] }>('/api/concerts');
   ```
   Errors throw `ApiError` with `status`, `code` and `message`.
3. Protect pages with `<RequireAuth>` (signed in) or `<RequireAuth group="organisers">`. Get the user from `useAuth()`.
4. Don't import from another feature's folder.
5. Replace `<FeaturePlaceholder>` with your real page.

Shared code lives in `src/app/` (layout, styles, 404), `src/api/` (API client) and `src/auth/` (login, `useAuth`, `RequireAuth`).

## Styling

The theme is in `src/app/styles.css`. Reuse it before writing your own:

| Class / variable | Use |
|---|---|
| `.card` or `.glass` | frosted glass panel |
| `.btn`, `.btn.ghost`, `.btn.small` | button-style links (`<button>` is already styled) |
| `.eyebrow`, `.muted`, `.small`, `.row`, `.stack` | text and layout helpers |
| `--glass`, `--ink`, `--coral`, `--radius`, `--shadow` | colours and sizes for your own CSS |

Put feature CSS in your own folder (e.g. `pages/discovery/concerts.css`) and import it from your page.

**Sample data:** until their APIs exist, the concert list shows one labelled sample card, and My Tickets shows one sample ticket from `pages/account/sampleTickets.ts`. Delete the sample once the real API works. Cards without an image show an empty box.

## Login

Until Cognito is live, `/login` is a **fake login**: type any user ID, and tick "Organiser" if you need the organiser pages. Use `org-1` as the organiser to see the seeded demo concert. Dev only.

When Cognito is ready, only `src/auth/` changes. Feature pages stay the same as long as they use `useAuth()` and `RequireAuth`, and never set the `x-dev-user-*` headers themselves.

## Configuration

Optional. Copy [`.env.example`](.env.example) to `.env.local` (gitignored). These values are baked into the browser bundle, so **never put secrets here**.

| Variable | Default | Use |
|---|---|---|
| `VITE_API_BASE_URL` | empty | Where API calls go. Empty = same domain. Set it at build time only if the API is on another domain. |
| `VITE_DEV_API_PROXY` | `http://localhost:3000` | Dev only: where Vite forwards `/api` and `/health`. |

## Deploying

1. `npm ci && npm run build` (set `VITE_API_BASE_URL` if needed).
2. `aws s3 sync frontend/dist s3://<site-bucket> --delete`, then invalidate CloudFront.

CloudFront needs:
- **SPA fallback:** return `/index.html` with status 200 for S3 403/404 errors, or refreshing a page like `/myaccount` fails.
- **`/api/*` and `/health` routed to the API.** Same domain means no CORS is needed. Without `/health`, the footer badge shows "API unreachable".
