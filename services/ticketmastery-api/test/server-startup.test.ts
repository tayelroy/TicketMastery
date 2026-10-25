/**
 * Start-up of src/server.ts in a child process (free local port, no database, no real Cognito: see
 * helpers/fake-jwks-preload.ts). Cognito mode must load the signing keys before listening and must exit rather than
 * serve traffic when it can't; dev-header mode must start exactly as before.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { describe, test } from 'node:test';
import { CLIENT_ID, POOL_ID } from './helpers/cognito';

interface LogLine {
  level: number;
  msg: string;
  authMode?: string;
}

interface StartResult {
  /** Exit code of the child. */
  code: number | null;
  logs: LogLine[];
  stderr: string;
}

/** A port that was free a moment ago (config.ts requires PORT >= 1, so the child can't be given 0). */
async function freePort(): Promise<number> {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the server with `env`; once it logs "listening" (or after it exits on its own) sends SIGTERM, then
 * resolves with its exit code and pino log lines.
 */
async function startServer(env: Record<string, string>): Promise<StartResult> {
  const { PATH, NODE_V8_COVERAGE } = process.env;
  const port = String(await freePort());
  // '.ts' under tsx (npm test), '.js' when this file runs from the tsc build (npm run test:coverage).
  const ext = extname(__filename);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', `./test/helpers/fake-jwks-preload${ext}`, `src/server${ext}`],
    {
      cwd: join(__dirname, '..'),
      env: {
        PATH,
        ...(NODE_V8_COVERAGE ? { NODE_V8_COVERAGE } : {}),
        PORT: port,
        LOG_LEVEL: 'info',
        APP_VERSION: 'test', // see helpers/cognito.ts
        DB_HOST: 'unused',
        DB_NAME: 'unused',
        DB_USER: 'unused',
        DB_PASSWORD: 'unused',
        ...env,
      },
    },
  );
  const logs: LogLine[] = [];
  let stderr = '';
  let buffered = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      const entry = JSON.parse(line) as LogLine;
      logs.push(entry);
      if (entry.msg === 'ticketmastery-api listening') child.kill('SIGTERM');
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, logs, stderr });
    });
  });
}

const messages = (r: StartResult) => r.logs.map((l) => l.msg);
const cognito = { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: POOL_ID, COGNITO_CLIENT_ID: CLIENT_ID };

describe('server start-up', () => {
  test('cognito: loads the signing keys, then listens, then shuts down cleanly on SIGTERM', async () => {
    const result = await startServer({ ...cognito, TM_TEST_JWKS: 'ok' });
    assert.deepEqual(messages(result), ['cognito signing keys loaded', 'ticketmastery-api listening', 'shutting down']);
    assert.equal(result.logs[1]!.authMode, 'cognito');
    assert.equal(result.code, 0, result.stderr);
  });

  test('cognito with Cognito unreachable: exits 1 without ever listening', async () => {
    const result = await startServer({ ...cognito, TM_TEST_JWKS: 'unreachable' });
    assert.equal(result.code, 1);
    assert.deepEqual(messages(result), ['failed to start']);
    assert.equal(result.logs[0]!.level, 60, 'logged as fatal');
  });

  test('dev-header (the local default): starts without contacting Cognito', async () => {
    const result = await startServer({ TM_TEST_JWKS: 'unreachable' });
    assert.deepEqual(messages(result), ['ticketmastery-api listening', 'shutting down']);
    assert.equal(result.logs[0]!.authMode, 'dev-header');
    assert.equal(result.code, 0, result.stderr);
  });

  test('dev-header in production with ALLOW_DEV_AUTH=true: starts, with the loud warning first', async () => {
    const result = await startServer({ NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true', TM_TEST_JWKS: 'unreachable' });
    assert.match(messages(result)[0]!, /^!!!!! AUTH_MODE=dev-header IN PRODUCTION/);
    assert.deepEqual(messages(result).slice(1), ['ticketmastery-api listening', 'shutting down']);
    assert.equal(result.code, 0, result.stderr);
  });
});
