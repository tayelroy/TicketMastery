# frontend/

> **Placeholder.** Nothing is built here yet.

| | |
|---|---|
| Owner (app shell, UC1 pages) | Nai Xin (UC1 discovery with Cody) |
| Hosting (S3, CloudFront, WAF, Route 53) | Cody |
| API contract | `services/ticketmastery-api` routes under `/api/...` (mounts listed in `src/modules/index.ts`); see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-api-routes) and [docs/architecture.md](../docs/architecture.md) |

## Suggested shape (not decided)

- A static single-page app. The framework is the owner's choice.
- `npm run build` writes to `frontend/dist/`, which is gitignored.
- Deploy by syncing `frontend/dist/` to the site S3 bucket (for example `aws s3 sync frontend/dist s3://<site-bucket> --delete`), then invalidate CloudFront. Cody owns the bucket, the distribution, and the deploy pipeline.
- The API base URL is a build-time setting such as `VITE_API_BASE_URL`, not a hardcoded value. Commit a `.env.example` here and never a real `.env`.
- Auth uses Cognito (Andrew). The SPA gets a JWT and sends it to API Gateway. Until that is live, the backend accepts `x-dev-user-id` / `x-dev-user-groups` headers when `AUTH_MODE=dev-header`. That is a dev shortcut only.

Before opening PRs, read [CONTRIBUTING.md](../CONTRIBUTING.md).
