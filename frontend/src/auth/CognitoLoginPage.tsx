import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  signIn,
  signUp,
  type SignInOutput,
} from 'aws-amplify/auth';
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** confirm: email code after sign-up. forgot, reset: forgot password. newPassword: replace an admin's temp password. */
type Mode = 'signIn' | 'signUp' | 'confirm' | 'forgot' | 'reset' | 'newPassword';

const TITLES: Record<Mode, string> = {
  signIn: 'Sign in',
  signUp: 'Create an account',
  confirm: 'Check your email',
  forgot: 'Reset your password',
  reset: 'Choose a new password',
  newPassword: 'Choose a new password',
};

const SUBMIT_LABELS: Record<Mode, string> = {
  signIn: 'Sign in',
  signUp: 'Create account',
  confirm: 'Verify',
  forgot: 'Send code',
  reset: 'Set password and sign in',
  newPassword: 'Set password and sign in',
};

/**
 * Real sign-up and sign-in against the Cognito user pool (AUTH_MODE=cognito). Uses Amplify's SRP flow, so the
 * password never leaves the browser. Fans register themselves; organisers are added to the `organisers` group by
 * an admin. Replaces DevLoginPage in AWS builds (see router.tsx).
 */
export function CognitoLoginPage() {
  const { session, ready } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  // The only navigation after sign-in: Amplify fires `signedIn`, AuthContext loads the session, and this effect runs.
  // Also covers opening /login while already signed in.
  useEffect(() => {
    if (session) navigate(from, { replace: true });
  }, [session, from, navigate]);

  function switchMode(next: Mode, message?: string) {
    setMode(next);
    setError(undefined);
    setNotice(message);
  }

  async function sendResetCode(message: string) {
    await resetPassword({ username: email });
    setCode('');
    setPassword('');
    switchMode('reset', message);
  }

  /** Signed in: nothing to do (see the effect). Otherwise show the step Cognito asks for. */
  async function handleSignInStep({ isSignedIn, nextStep }: SignInOutput) {
    if (isSignedIn) return;
    switch (nextStep.signInStep) {
      case 'CONFIRM_SIGN_UP':
        await resendSignUpCode({ username: email });
        switchMode('confirm', 'Your email is not verified yet. We sent you a new code.');
        break;
      case 'RESET_PASSWORD': // an admin reset the password
        await sendResetCode('Your password was reset. We emailed you a code to choose a new one.');
        break;
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': // an admin created the user with a temporary password
        setPassword('');
        switchMode('newPassword', 'Your account has a temporary password. Choose your own to finish signing in.');
        break;
      default:
        setError(`This sign-in step isn't supported here (${nextStep.signInStep}). Contact the TicketMastery team.`);
    }
  }

  const signInWithPassword = async () => handleSignInStep(await signIn({ username: email, password }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      if (mode === 'signIn') {
        await signInWithPassword();
      } else if (mode === 'signUp') {
        const { nextStep } = await signUp({ username: email, password, options: { userAttributes: { email } } });
        if (nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
          switchMode('confirm', `We emailed a 6-digit code to ${email}.`);
        } else {
          await signInWithPassword();
        }
      } else if (mode === 'confirm') {
        await confirmSignUp({ username: email, confirmationCode: code.trim() });
        await signInWithPassword();
      } else if (mode === 'forgot') {
        // The pool hides whether an account exists (prevent_user_existence_errors), so the wording can't promise it.
        await sendResetCode(`If an account exists for ${email}, we emailed it a code.`);
      } else if (mode === 'reset') {
        await confirmResetPassword({ username: email, confirmationCode: code.trim(), newPassword: password });
        await signInWithPassword();
      } else {
        await handleSignInStep(await confirmSignIn({ challengeResponse: password }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setError(undefined);
    setBusy(true);
    try {
      if (mode === 'reset') {
        await sendResetCode(`We sent a new code to ${email}.`);
      } else {
        await resendSignUpCode({ username: email });
        setNotice(`We sent a new code to ${email}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the code.');
    } finally {
      setBusy(false);
    }
  }

  const askEmail = mode === 'signIn' || mode === 'signUp' || mode === 'forgot';
  const askCode = mode === 'confirm' || mode === 'reset';
  const choosePassword = mode === 'signUp' || mode === 'reset' || mode === 'newPassword';
  const askPassword = mode === 'signIn' || choosePassword;

  return (
    <section className="card pass">
      <div className="pass-head">
        <p className="eyebrow">TicketMastery account</p>
        <h1>{TITLES[mode]}</h1>
      </div>
      <div className="pass-body">
        <form onSubmit={onSubmit} className="stack">
          {askEmail && (
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
          )}

          {askCode && (
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

          {askPassword && (
            <label className="field">
              <span>{mode === 'signIn' || mode === 'signUp' ? 'Password' : 'New password'}</span>
              {/* minLength and the hint mirror password_policy in infra/modules/auth-apigw/cognito.tf. */}
              <input
                type="password"
                autoComplete={choosePassword ? 'new-password' : 'current-password'}
                required
                minLength={choosePassword ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus={mode === 'newPassword'}
              />
            </label>
          )}
          {choosePassword && (
            <p className="muted small">At least 10 characters, with upper and lower case letters and a number.</p>
          )}

          {notice && <p className="muted small">{notice}</p>}
          {error && (
            <p className="small" role="alert">
              {error}
            </p>
          )}

          {/* Not before `ready`: signing in while Amplify still restores a session fails (already signed in). */}
          <button type="submit" disabled={busy || !ready}>
            {busy || !ready ? 'Please wait…' : SUBMIT_LABELS[mode]}
          </button>
        </form>

        <div className="row small">
          {mode === 'signIn' && (
            <>
              <button type="button" className="link" onClick={() => switchMode('signUp')}>
                New here? Create an account
              </button>
              <button type="button" className="link" onClick={() => switchMode('forgot')}>
                Forgot your password?
              </button>
            </>
          )}
          {mode === 'signUp' && (
            <button type="button" className="link" onClick={() => switchMode('signIn')}>
              Already have an account? Sign in
            </button>
          )}
          {askCode && (
            <button type="button" className="link" onClick={onResend} disabled={busy}>
              Resend the code
            </button>
          )}
          {(mode === 'forgot' || mode === 'reset' || mode === 'newPassword') && (
            <button type="button" className="link" onClick={() => switchMode('signIn')}>
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
