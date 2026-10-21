import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { ORGANISERS_GROUP } from './session';

/**
 * Fake login for local development. It only picks the x-dev-user-* headers the API trusts in
 * AUTH_MODE=dev-header; nothing is verified. Andrew's Cognito sign-in replaces this page.
 */
export function DevLoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  const [userId, setUserId] = useState('fan-1');
  const [organiser, setOrganiser] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = userId.trim();
    if (!id) return;
    signIn({ userId: id, groups: organiser ? [ORGANISERS_GROUP] : [] });
    navigate(from, { replace: true });
  }

  return (
    <section className="card pass">
      <div className="pass-head">
        <p className="eyebrow">Local dev login</p>
        <h1>Sign in</h1>
      </div>
      <div className="pass-body">
        <p className="muted small">
          Fake login: no password, and the API trusts whatever you enter. Use <code>org-1</code> as an organiser to
          see the seeded demo concert.
        </p>
        <form onSubmit={onSubmit} className="stack">
          <label className="field">
            <span>User ID</span>
            <input value={userId} onChange={(e) => setUserId(e.target.value)} autoFocus />
          </label>
          <label className="check">
            <input type="checkbox" checked={organiser} onChange={(e) => setOrganiser(e.target.checked)} />
            <span>
              Organiser (group <code>{ORGANISERS_GROUP}</code>)
            </span>
          </label>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </section>
  );
}
