/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_MODE?: 'dev-header' | 'cognito';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
