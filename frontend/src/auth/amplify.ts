import { Amplify } from 'aws-amplify';

/**
 * 'cognito' in AWS builds (real sign-in, Bearer tokens); 'dev-header' (fake login, x-dev-user-* headers) for
 * local work against an API running AUTH_MODE=dev-header. Set VITE_AUTH_MODE at build time.
 */
export const AUTH_MODE: 'dev-header' | 'cognito' =
  import.meta.env.VITE_AUTH_MODE === 'cognito' ? 'cognito' : 'dev-header';

/** Call once before rendering. The pool and client IDs are public identifiers, not secrets. */
export function configureAuth(): void {
  if (AUTH_MODE !== 'cognito') return;
  const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
  const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
  if (!userPoolId || !userPoolClientId) {
    throw new Error('VITE_AUTH_MODE=cognito needs VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID at build time');
  }
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: { email: true },
        signUpVerificationMethod: 'code',
      },
    },
  });
}
