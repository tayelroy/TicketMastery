import { confirmSignUp, resendSignUpCode, signIn, signUp } from 'aws-amplify/auth';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

type Mode = 'signIn' | 'signUp' | 'confirm';

const TITLES: Record<Mode, string> = {
  signIn: 'Sign in',
  signUp: 'Create an account',
  confirm: 'Check your email',
};

/**
 * Real sign-up and sign-in against the Cognito user pool (AUTH_MODE=cognito). Uses Amplify's SRP flow, so the
 * password never leaves the browser. Fans register themselves; organisers are added to the `organisers` group by
 * an admin. Replaces DevLoginPage in AWS builds (see router.tsx).
 */
export function CognitoLoginPage() {
  const { session, refresh } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Already signed in (e.g. opened /login directly): go back.
  useEffect(() => {
    if (session) navigate(from, { replace: true });
  }, [session, from, navigate]);

  async function finishSignIn() {
    const { isSignedIn, nextStep } = await signIn({ username: email, password });
    if (isSignedIn) {
      await refresh(); // load the session before navigating, or RequireAuth bounces back here
      navigate(from, { replace: true });
    } else if (nextStep.signInStep === 'CONFIRM_SIGN_UP') {
      await resendSignUpCode({ username: email });
      setMode('confirm');
      setNotice('Your email is not verified yet. We sent you a new code.');
    } else {
      setError(`Sign-in needs another step (${nextStep.signInStep}). Ask an admin to reset the account.`);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      if (mode === 'signIn') {
        await finishSignIn();
      } else if (mode === 'signUp') {
        const { nextStep } = await signUp({ username: email, password, options: { userAttributes: { email } } });
        if (nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
          setMode('confirm');
          setNotice(`We emailed a 6-digit code to ${email}.`);
        } else {
          await finishSignIn();
        }
      } else {
        await confirmSignUp({ username: email, confirmationCode: code.trim() });
        await finishSignIn();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setError(undefined);
    try {
      await resendSignUpCode({ username: email });
      setNotice(`We sent a new code to ${email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.');
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(undefined);
    setNotice(undefined);
  }

  return (
    <section className="card pass">
      <div className="pass-head">
        <p className="eyebrow">TicketMastery account</p>
        <h1>{TITLES[mode]}</h1>
      </div>
      <div className="pass-body">
        <form onSubmit={onSubmit} className="stack">
          {mode !== 'confirm' && (
            <>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value.trim())}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                  required
                  minLength={10}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {mode === 'signUp' && (
                <p className="muted small">At least 10 characters, with upper and lower case letters and a number.</p>
              )}
            </>
          )}

          {mode === 'confirm' && (
            <label className="field">
              <span>Verification code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            </label>
          )}

          {notice && <p className="muted small">{notice}</p>}
          {error && (
            <p className="small" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signIn' ? 'Sign in' : mode === 'signUp' ? 'Create account' : 'Verify'}
          </button>
        </form>

        <div className="row small">
          {mode === 'signIn' && (
            <button type="button" className="link" onClick={() => switchMode('signUp')}>
              New here? Create an account
            </button>
          )}
          {mode === 'signUp' && (
            <button type="button" className="link" onClick={() => switchMode('signIn')}>
              Already have an account? Sign in
            </button>
          )}
          {mode === 'confirm' && (
            <button type="button" className="link" onClick={onResend}>
              Resend the code
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
