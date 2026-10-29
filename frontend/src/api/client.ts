import { authHeaders } from '../auth/session';

/** Empty in local dev (the Vite proxy forwards /api), set at build time for AWS. No trailing slash. */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** Mirrors the API error body: `{"error": {"code", "message", "details?"}}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  /** Sent as JSON. */
  body?: unknown;
}

/**
 * The one way pages call the backend. Adds the API base URL, auth headers and JSON handling, and
 * throws ApiError for non-2xx responses. Paths start with `/api/...` (or `/health`).
 */
export async function api<T>(path: string, { body, headers, ...init }: ApiOptions = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(await authHeaders()),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data: unknown = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
