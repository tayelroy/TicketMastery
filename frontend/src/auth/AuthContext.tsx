import { signOut as amplifySignOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AUTH_MODE } from './amplify';
import { loadCognitoSession, loadSession, saveSession, type Session } from './session';

interface AuthContextValue {
  session: Session | null;
  /** False until the cognito session has been checked once (avoids a /login bounce on page reload). */
  ready: boolean;
  /** Dev-header mode: store the fake session. */
  signIn: (session: Pick<Session, 'userId' | 'groups'>) => void;
  signOut: () => void;
  /** Cognito mode: re-read the session from Amplify (call after signIn resolves, before navigating). */
  refresh: () => Promise<void>;
  hasGroup: (group: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => (AUTH_MODE === 'dev-header' ? loadSession() : null));
  const [ready, setReady] = useState(AUTH_MODE === 'dev-header');

  const refresh = useCallback(async () => {
    if (AUTH_MODE !== 'cognito') return;
    setSession(await loadCognitoSession());
    setReady(true);
  }, []);

  useEffect(() => {
    if (AUTH_MODE !== 'cognito') return;
    void refresh();
    // Keep the session in step with Amplify (sign-in elsewhere in the app, token refresh, sign-out).
    return Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'tokenRefresh') void refresh();
      if (payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') setSession(null);
    });
  }, [refresh]);

  const signIn = useCallback(({ userId, groups }: Pick<Session, 'userId' | 'groups'>) => {
    const next = { userId, groups, displayName: userId };
    saveSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(() => {
    if (AUTH_MODE === 'cognito') {
      // Also revokes the refresh token (enable_token_revocation on the app client).
      void amplifySignOut();
    } else {
      saveSession(null);
    }
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      ready,
      signIn,
      signOut,
      refresh,
      hasGroup: (g) => session?.groups.includes(g) ?? false,
    }),
    [session, ready, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
