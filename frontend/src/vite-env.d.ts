/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_MODE?: 'dev-header' | 'cognito';
  /** Cognito user pool and app client IDs (public identifiers; Terraform outputs). Needed when VITE_AUTH_MODE=cognito. */
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
