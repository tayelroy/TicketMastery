import { fetchAuthSession, fetchUserAttributes, updateUserAttributes } from 'aws-amplify/auth';
import { useEffect, useState, type FormEvent } from 'react';
import { AUTH_MODE } from '../../auth/amplify';

/**
 * UC2 view / update profile. The profile lives in Cognito (the API only knows the user's `sub`), so the browser reads
 * and updates it directly with Amplify. The email is the sign-in name, so it is read-only here.
 */
export function ProfileCard() {
  if (AUTH_MODE !== 'cognito') {
    return (
      <section className="profile-card glass">
        <h2>Profile</h2>
        <p className="muted small">Your profile is kept by real sign-in (Cognito). The fake login has no profile.</p>
      </section>
    );
  }
  return <CognitoProfileForm />;
}

function CognitoProfileForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetchUserAttributes()
      .then((a) => {
        if (cancelled) return;
        setEmail(a.email ?? '');
        setName(a.name ?? '');
        setLoaded(true);
      })
      .catch(() => !cancelled && setStatus('Could not load your profile.'));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(undefined);
    try {
      await updateUserAttributes({ userAttributes: { name: name.trim() } });
      // New tokens carry the new name. Amplify then fires `tokenRefresh`, and AuthContext updates the header.
      await fetchAuthSession({ forceRefresh: true });
      setName(name.trim());
      setStatus('Saved.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not save your profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="profile-card glass stack" onSubmit={onSave}>
      <h2>Profile</h2>
      <label className="field">
        <span>Email</span>
        <input value={email} readOnly />
      </label>
      <label className="field">
        <span>Display name</span>
        <input value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" disabled={!loaded || busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
        {status && (
          <span className="muted small" role="status">
            {status}
          </span>
        )}
      </div>
    </form>
  );
}
