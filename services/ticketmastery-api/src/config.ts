import { z } from 'zod';

/**
 * Environment-variable parser for booleans. `z.coerce.boolean()` treats the
 * string "false" as true, so parse the usual spellings explicitly.
 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true' || v === '1' || v === 'yes'));

/** Treat empty strings (common in .env files / ECS task defs) as "unset". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Optional build identifier (e.g. git SHA) injected by the deploy pipeline; falls back to package.json version. */
    APP_VERSION: optionalString,

    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_PASSWORD: z.string().min(1),
    // RDS requires TLS (rds.force_ssl=1 by default on PG15+). See db/pool.ts for the CA note.
    DB_SSL: boolFromEnv(false),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    AUTH_MODE: z.enum(['dev-header', 'cognito']).default('dev-header'),
    /**
     * Escape hatch so the ECS task can run with AUTH_MODE=dev-header in production
     * until Cognito (Andrew) is wired up. Infra sets this to true for now.
     */
    ALLOW_DEV_AUTH: boolFromEnv(false),
    COGNITO_USER_POOL_ID: optionalString,
    COGNITO_CLIENT_ID: optionalString,

    RUN_MIGRATIONS_ON_START: boolFromEnv(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev-header' && !env.ALLOW_DEV_AUTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message:
          'AUTH_MODE=dev-header lets any caller impersonate any user and is refused when NODE_ENV=production. ' +
          'Set AUTH_MODE=cognito, or ALLOW_DEV_AUTH=true to accept the risk temporarily.',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // The logger depends on config, so report straight to stderr and stop.
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`).join('\n');
    process.stderr.write(`Invalid environment configuration:\n${details}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config: Config = loadConfig(process.env);

/** True when dev-header auth is active in production via ALLOW_DEV_AUTH (logged loudly at startup). */
export const devAuthInProduction = config.NODE_ENV === 'production' && config.AUTH_MODE === 'dev-header';
