import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { AUTH_MODE } from './amplify';
import { useAuth } from './AuthContext';

/** Sends anonymous users to /login, and shows a 403 message if `group` is set and missing. */
export function RequireAuth({ group, children }: { group?: string; children: ReactNode }) {
  const { session, ready, hasGroup } = useAuth();
  const location = useLocation();

  if (!ready) {
    return <p className="muted">Checking sign-in…</p>;
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (group && !hasGroup(group)) {
    return (
      <section className="card">
        <h1>Not allowed</h1>
        <p>
          This page needs the <code>{group}</code> group.{' '}
          {AUTH_MODE === 'cognito'
            ? 'Ask an admin to add your account to it, then sign out and sign in again.'
            : 'Sign in again and tick it.'}
        </p>
      </section>
    );
  }
  return <>{children}</>;
}
