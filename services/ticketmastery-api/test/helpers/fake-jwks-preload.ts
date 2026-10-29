/**
 * Preloaded (`--import`) into child processes that start src/server.ts, so start-up never reaches real Cognito.
 * TM_TEST_JWKS=ok serves a JWKS; anything else makes Cognito unreachable.
 */
import { FakeJwksEndpoint, poolKey } from './cognito';

const jwks = new FakeJwksEndpoint();
if (process.env.TM_TEST_JWKS === 'ok') jwks.behaviour = { keys: [poolKey.jwk] };
jwks.install();
