/**
 * Tests for src/config.ts: defaults, parsing, the start-up safety checks (dev-header in production, cognito without
 * its IDs) and what happens when the environment is invalid. The schema is tested in-process; the exit-on-error
 * path and the exported flags run in a child process, because config.ts reads process.env once, on import.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { before, describe, mock, test } from 'node:test';
import type * as ConfigModule from '../src/config';

/** Smallest valid environment: the DB settings are the only required values. */
const base = { DB_HOST: 'db.local', DB_NAME: 'tm', DB_USER: 'tm', DB_PASSWORD: 'secret' };
const cognitoIds = { COGNITO_USER_POOL_ID: 'ap-southeast-1_Abc', COGNITO_CLIENT_ID: 'client123' };
const COGNITO_MESSAGE =
  'AUTH_MODE=cognito needs COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID ' +
  '(in AWS they come from module.auth_apigw outputs via extra_environment).';

describe('config', () => {
  let envSchema: typeof ConfigModule.envSchema;
  let loadConfig: typeof ConfigModule.loadConfig;

  before(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', ...base });
    ({ envSchema, loadConfig } = await import('../src/config.js'));
  });

  function parse(env: Record<string, string>) {
    const result = envSchema.safeParse(env);
    assert.ok(result.success, JSON.stringify(!result.success && result.error.issues));
    return result.data;
  }

  /** Asserts the env is refused and returns the issues as "path: message". */
  function issues(env: Record<string, string>): string[] {
    const result = envSchema.safeParse(env);
    assert.equal(result.success, false, 'expected the environment to be refused');
    return result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }

  describe('defaults and parsing', () => {
    test('a minimal environment gets the documented defaults (unset optionals stay absent)', () => {
      assert.deepEqual(parse(base), {
        NODE_ENV: 'development',
        PORT: 3000,
        LOG_LEVEL: 'info',
        ...base,
        DB_PORT: 5432,
        DB_SSL: false,
        DB_POOL_MAX: 10,
        AUTH_MODE: 'dev-header',
        ALLOW_DEV_AUTH: false,
        RUN_MIGRATIONS_ON_START: false,
      });
    });

    test('numbers are coerced and range-checked', () => {
      const env = parse({ ...base, PORT: '8080', DB_PORT: '6543', DB_POOL_MAX: '25' });
      assert.deepEqual([env.PORT, env.DB_PORT, env.DB_POOL_MAX], [8080, 6543, 25]);
      assert.deepEqual(
        issues({ ...base, PORT: '0' }).map((i) => i.split(':')[0]),
        ['PORT'],
      );
      assert.deepEqual(
        issues({ ...base, DB_POOL_MAX: '101' }).map((i) => i.split(':')[0]),
        ['DB_POOL_MAX'],
      );
    });

    for (const [raw, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ] as const) {
      test(`boolean "${raw}" parses as ${expected}`, () => {
        const env = parse({ ...base, DB_SSL: raw, ALLOW_DEV_AUTH: raw, RUN_MIGRATIONS_ON_START: raw });
        assert.deepEqual([env.DB_SSL, env.ALLOW_DEV_AUTH, env.RUN_MIGRATIONS_ON_START], [expected, expected, expected]);
      });
    }

    test('booleans reject other spellings instead of guessing', () => {
      for (const raw of ['TRUE', 'on', '']) {
        assert.deepEqual(
          issues({ ...base, DB_SSL: raw }).map((i) => i.split(':')[0]),
          ['DB_SSL'],
          raw,
        );
      }
    });

    test('empty or blank optional strings count as unset; other values are kept', () => {
      for (const blank of ['', '   ']) {
        const env = parse({ ...base, APP_VERSION: blank, COGNITO_USER_POOL_ID: blank, COGNITO_CLIENT_ID: blank });
        assert.deepEqual(
          [env.APP_VERSION, env.COGNITO_USER_POOL_ID, env.COGNITO_CLIENT_ID],
          [undefined, undefined, undefined],
        );
      }
      assert.equal(parse({ ...base, APP_VERSION: 'abc123' }).APP_VERSION, 'abc123');
    });

    test('required DB settings and enums are enforced', () => {
      assert.deepEqual(
        issues({ DB_NAME: 'tm', DB_USER: 'tm', DB_PASSWORD: 'x' }).map((i) => i.split(':')[0]),
        ['DB_HOST'],
      );
      assert.deepEqual(
        issues({ ...base, AUTH_MODE: 'basic' }).map((i) => i.split(':')[0]),
        ['AUTH_MODE'],
      );
      assert.deepEqual(
        issues({ ...base, NODE_ENV: 'staging' }).map((i) => i.split(':')[0]),
        ['NODE_ENV'],
      );
    });
  });

  describe('AUTH_MODE=dev-header in production', () => {
    test('is refused unless ALLOW_DEV_AUTH=true', () => {
      const [issue, ...rest] = issues({ ...base, NODE_ENV: 'production' });
      assert.equal(rest.length, 0);
      assert.match(issue!, /^AUTH_MODE: AUTH_MODE=dev-header lets any caller impersonate any user/);
      assert.equal(issues({ ...base, NODE_ENV: 'production', ALLOW_DEV_AUTH: 'false' }).length, 1);
    });

    test('is allowed with ALLOW_DEV_AUTH=true, and outside production', () => {
      assert.equal(parse({ ...base, NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true' }).AUTH_MODE, 'dev-header');
      assert.equal(parse({ ...base, NODE_ENV: 'development' }).AUTH_MODE, 'dev-header');
      assert.equal(parse({ ...base, NODE_ENV: 'test' }).AUTH_MODE, 'dev-header');
    });
  });

  describe('AUTH_MODE=cognito', () => {
    test('is accepted with both IDs, in production too', () => {
      for (const NODE_ENV of ['development', 'production']) {
        const env = parse({ ...base, NODE_ENV, AUTH_MODE: 'cognito', ...cognitoIds });
        assert.deepEqual(
          [env.AUTH_MODE, env.COGNITO_USER_POOL_ID, env.COGNITO_CLIENT_ID],
          ['cognito', 'ap-southeast-1_Abc', 'client123'],
        );
      }
    });

    const missing: Array<[string, Record<string, string>]> = [
      ['both IDs missing', {}],
      ['user pool ID missing', { COGNITO_CLIENT_ID: 'client123' }],
      ['client ID missing', { COGNITO_USER_POOL_ID: 'ap-southeast-1_Abc' }],
      ['IDs blank (as ECS passes an unset value)', { COGNITO_USER_POOL_ID: ' ', COGNITO_CLIENT_ID: '' }],
    ];
    for (const [name, ids] of missing) {
      test(`is refused with ${name}`, () => {
        assert.deepEqual(issues({ ...base, AUTH_MODE: 'cognito', ...ids }), [`AUTH_MODE: ${COGNITO_MESSAGE}`]);
      });
    }

    test('dev-header mode does not need the IDs', () => {
      assert.equal(parse({ ...base, AUTH_MODE: 'dev-header' }).COGNITO_USER_POOL_ID, undefined);
    });
  });

  describe('loadConfig', () => {
    /** Runs loadConfig with process.exit and stderr intercepted; returns the exit code and what was written. */
    class ExitCalled extends Error {
      constructor(readonly code: number | undefined) {
        super(`process.exit(${code})`);
      }
    }

    function loadFailing(env: unknown): { code: number | undefined; stderr: string } {
      let stderr = '';
      const write = mock.method(process.stderr, 'write', (chunk: string) => {
        stderr += chunk;
        return true;
      });
      const exit = mock.method(process, 'exit', (code?: number) => {
        throw new ExitCalled(code);
      });
      try {
        loadConfig(env as NodeJS.ProcessEnv);
      } catch (err) {
        if (err instanceof ExitCalled) return { code: err.code, stderr };
        throw err;
      } finally {
        write.mock.restore();
        exit.mock.restore();
      }
      assert.fail('loadConfig should have exited');
    }

    test('returns the parsed config for a valid environment', () => {
      assert.equal(loadConfig({ ...base, PORT: '4000' }).PORT, 4000);
    });

    test('reports each issue as "path: message" and exits 1', () => {
      assert.deepEqual(loadFailing({ ...base, AUTH_MODE: 'cognito' }), {
        code: 1,
        stderr: `Invalid environment configuration:\n  - AUTH_MODE: ${COGNITO_MESSAGE}\n`,
      });
    });

    test('labels an issue without a field path as (env)', () => {
      const { code, stderr } = loadFailing(undefined);
      assert.equal(code, 1);
      assert.match(stderr, /^Invalid environment configuration:\n {2}- \(env\): .+\n$/);
    });
  });

  describe('loading on import (child process)', () => {
    /** Imports src/config.ts in a fresh process with exactly `env` and prints the exported flags. */
    function load(env: Record<string, string>) {
      const script =
        "const c = require('./src/config');" +
        'process.stdout.write(JSON.stringify({ mode: c.config.AUTH_MODE, devAuthInProduction: c.devAuthInProduction }));';
      // Only PATH (and the coverage directory, when c8 runs us) is inherited, so nothing leaks in from this process.
      const { PATH, NODE_V8_COVERAGE } = process.env;
      return spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
        cwd: join(__dirname, '..'),
        env: { PATH, ...(NODE_V8_COVERAGE ? { NODE_V8_COVERAGE } : {}), ...env },
        encoding: 'utf8',
      });
    }

    test('an invalid environment exits 1 and lists the problems on stderr', () => {
      const child = load({ DB_NAME: 'tm', DB_USER: 'tm', DB_PASSWORD: 'x', PORT: 'abc' });
      assert.equal(child.status, 1);
      assert.equal(child.stdout, '');
      assert.match(child.stderr, /^Invalid environment configuration:\n {2}- PORT: .+\n {2}- DB_HOST: .+\n$/);
    });

    test('cognito without its IDs exits 1 with the fix in the message', () => {
      // zod runs the cross-field checks only once every field is valid, hence a valid base here.
      const child = load({ ...base, NODE_ENV: 'production', AUTH_MODE: 'cognito' });
      assert.equal(child.status, 1);
      assert.equal(child.stderr, `Invalid environment configuration:\n  - AUTH_MODE: ${COGNITO_MESSAGE}\n`);
    });

    test('devAuthInProduction is true only for dev-header + production (ALLOW_DEV_AUTH=true)', () => {
      const cases: Array<[Record<string, string>, { mode: string; devAuthInProduction: boolean }]> = [
        [
          { NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true' },
          { mode: 'dev-header', devAuthInProduction: true },
        ],
        [
          { NODE_ENV: 'production', AUTH_MODE: 'cognito', ...cognitoIds },
          { mode: 'cognito', devAuthInProduction: false },
        ],
        [{ NODE_ENV: 'development' }, { mode: 'dev-header', devAuthInProduction: false }],
      ];
      for (const [env, expected] of cases) {
        const child = load({ ...base, ...env });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), expected);
      }
    });
  });
});
