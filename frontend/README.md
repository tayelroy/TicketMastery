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
| http://localhost:5173/concerts/123/waiting-room | Waiting room (UC3) | sign in |
| http://localhost:5173/concerts/123/checkout | Checkout (UC4) | sign in |
| http://localhost:5173/myaccount | My Tickets (UC2) | sign in |
| http://localhost:5173/myaccount/tickets/:orderId | One e-ticket (UC2) | sign in; open it from My Tickets |
| http://localhost:5173/organiser | Organiser dashboard (UC5) | sign in with the `organisers` group (fake login: `org-1` with "Organiser" ticked) |
| http://localhost:5173/login | Login | fake login by default (any user ID, no password); Cognito sign-in with `VITE_AUTH_MODE=cognito` |

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

Cards and tickets without an image show an empty box.

## Login

`VITE_AUTH_MODE` picks one of two logins. Pages don't care which: use `useAuth()` (`session.userId`, `session.displayName`, `hasGroup()`) and `RequireAuth`, and never set auth headers yourself. All login code lives in `src/auth/`.

- **`dev-header` (default, local dev):** `/login` is a **fake login**. Type any user ID, and tick "Organiser" if you need the organiser pages. Use `org-1` as the organiser to see the seeded demo concert. The API client sends `x-dev-user-*` headers, which only a local API with `AUTH_MODE=dev-header` accepts.
- **`cognito` (the deployed site):** `/login` is real sign-up and sign-in against the Cognito user pool (`aws-amplify`), with an email code to confirm sign-up and a "Forgot your password?" flow. The API client sends `Authorization: Bearer <access token>`. Fans sign up themselves. To become an organiser, an admin adds the account to the `organisers` group; then sign out and sign in again so the token includes it. User IDs are Cognito `sub` UUIDs, so the seeded `org-1` concert isn't visible: create a concert from the organiser page.

To try Cognito locally against the dev API in AWS, set `VITE_AUTH_MODE=cognito`, the two `VITE_COGNITO_*` IDs and `VITE_DEV_API_PROXY=<api_endpoint>` (`terraform output -raw api_endpoint`) in `.env.local`.

## Configuration

Optional. Copy [`.env.example`](.env.example) to `.env.local` (gitignored). These values are baked into the browser bundle, so **never put secrets here**.

| Variable | Default | Use |
|---|---|---|
| `VITE_API_BASE_URL` | empty | Where API calls go. Empty = same domain. Set it at build time only if the API is on another domain. |
| `VITE_DEV_API_PROXY` | `http://localhost:3000` | Dev only: where Vite forwards `/api` and `/health`. Can be the API Gateway URL. |
| `VITE_AUTH_MODE` | `dev-header` | `dev-header` (fake login) or `cognito` (real sign-in). See [Login](#login). |
| `VITE_COGNITO_USER_POOL_ID` | empty | Cognito mode: `terraform output -raw cognito_user_pool_id`. Public ID, not a secret. |
| `VITE_COGNITO_CLIENT_ID` | empty | Cognito mode: `terraform output -raw cognito_user_pool_client_id`. Public ID, not a secret. |

In cognito mode the app stops at start-up with an error if either Cognito ID is missing.

## Deploying

Use the **Deploy Frontend to AWS** GitHub workflow (Actions → Run workflow, on `main`). It builds with `VITE_AUTH_MODE=cognito` and the Cognito IDs from the repository variables `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` (Settings → Secrets and variables → Actions → Variables), uploads to S3 and invalidates CloudFront. It stops before uploading if either variable is empty. If the user pool is ever recreated, both IDs change: update the variables and run the workflow again.

By hand, the same steps are:
1. `npm ci && npm run build` with `VITE_AUTH_MODE=cognito` and the two `VITE_COGNITO_*` IDs set (and `VITE_API_BASE_URL` only if the API is on another domain).
2. `aws s3 sync frontend/dist s3://<site-bucket> --delete`, then invalidate CloudFront.

CloudFront needs:
- **SPA fallback:** return `/index.html` with status 200 for S3 403/404 errors, or refreshing a page like `/myaccount` fails.
- **`/api/*` and `/health` routed to the API.** Same domain means no CORS is needed. Without `/health`, the footer badge shows "API unreachable".
