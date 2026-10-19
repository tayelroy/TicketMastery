/**
 * Who the browser is signed in as. For now this is a fake login that the API trusts while it runs
 * AUTH_MODE=dev-header. When Cognito lands (Andrew), only this file and the login page change:
 * store the Cognito tokens here and send `Authorization: Bearer <jwt>` from authHeaders().
 */
export interface Session {
  /** Becomes `req.user.sub` on the API. */
  userId: string;
  /** Becomes `req.user.groups`, e.g. ['organisers']. */
  groups: string[];
}

export const ORGANISERS_GROUP = 'organisers';

const STORAGE_KEY = 'tm.devSession';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return typeof parsed.userId === 'string' && Array.isArray(parsed.groups) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window); the session just won't survive a reload.
  }
}

/** Headers the API client attaches to every request. */
export function authHeaders(): Record<string, string> {
  const session = loadSession();
  if (!session) return {};
  // DEV STUB: replace with `authorization: Bearer <cognito token>` once AUTH_MODE=cognito.
  return {
    'x-dev-user-id': session.userId,
    ...(session.groups.length ? { 'x-dev-user-groups': session.groups.join(',') } : {}),
  };
}
