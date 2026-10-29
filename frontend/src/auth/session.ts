import { fetchAuthSession } from 'aws-amplify/auth';
import { AUTH_MODE } from './amplify';

/**
 * Who the browser is signed in as. In AUTH_MODE=cognito it comes from the Cognito access token (Amplify keeps and
 * refreshes the tokens); in dev-header mode it is the fake login stored in localStorage.
 */
export interface Session {
  /** Becomes `req.user.sub` on the API (the Cognito `sub` in cognito mode). */
  userId: string;
  /** Becomes `req.user.groups`, e.g. ['organisers']. */
  groups: string[];
  /** Cognito mode only: shown in the header instead of the sub. */
  email?: string;
}

export const ORGANISERS_GROUP = 'organisers';

const STORAGE_KEY = 'tm.devSession';

/** Dev-header mode only. */
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

/** Dev-header mode only. */
export function saveSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window); the session just won't survive a reload.
  }
}

/** Cognito mode: the current session from Amplify's tokens (refreshing them if expired), or null if signed out. */
export async function loadCognitoSession(): Promise<Session | null> {
  try {
    const { tokens } = await fetchAuthSession();
    const access = tokens?.accessToken;
    if (!access?.payload.sub) return null;
    const groups = access.payload['cognito:groups'];
    const email = tokens?.idToken?.payload.email;
    return {
      userId: access.payload.sub,
      groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [],
      email: typeof email === 'string' ? email : undefined,
    };
  } catch {
    return null;
  }
}

/** Headers the API client attaches to every request. */
export async function authHeaders(): Promise<Record<string, string>> {
  if (AUTH_MODE === 'cognito') {
    try {
      const { tokens } = await fetchAuthSession();
      return tokens?.accessToken ? { authorization: `Bearer ${tokens.accessToken.toString()}` } : {};
    } catch {
      return {};
    }
  }
  // DEV STUB: only works while the API runs AUTH_MODE=dev-header.
  const session = loadSession();
  if (!session) return {};
  return {
    'x-dev-user-id': session.userId,
    ...(session.groups.length ? { 'x-dev-user-groups': session.groups.join(',') } : {}),
  };
}
