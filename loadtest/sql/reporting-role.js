// Sets or removes the login of the read-only database role reporting_ro (created NOLOGIN by migration 0004), which the
// reporting ECS service connects as. Runs with the API's own `pg` package and DB settings: inside an ECS task of a
// service with the master credentials (organiser by default) through ECS Exec (piped to `node -` from /app, see
// scripts/reporting-user.sh) or locally against docker-compose Postgres.
// Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL (the task's own), ROLE_ACTION (rotate | disable),
// ROLE_VERIFIER_B64 (rotate: base64 of a SCRAM-SHA-256 verifier; the plaintext password never reaches this process).
// Prints one line: REPORTING_ROLE_RESULT {json}
'use strict';
const fs = require('fs');

// ECS Exec sessions normally inherit the container environment; fall back to PID 1's if they don't.
if (!process.env.DB_PASSWORD) {
  try {
    for (const kv of fs.readFileSync('/proc/1/environ', 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0 && kv.startsWith('DB_') && process.env[kv.slice(0, i)] === undefined)
        process.env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch (e) {
    /* not in a container */
  }
}

const { Client } = require('pg');
const ROLE = 'reporting_ro';
const VIEWS = [
  'report_confirmed_orders',
  'report_sales_by_concert',
  'report_sales_by_ticket_type',
  'report_sales_by_day',
  'report_seat_status',
];
const action = process.env.ROLE_ACTION;
const verifier = Buffer.from(process.env.ROLE_VERIFIER_B64 || '', 'base64').toString('utf8');

const client = new Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  statement_timeout: 30000,
});

(async () => {
  if (action !== 'rotate' && action !== 'disable')
    throw new Error(`ROLE_ACTION must be rotate or disable, got ${action}`);
  // SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>, as stored in pg_authid.
  if (action === 'rotate' && !/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) {
    throw new Error('ROLE_VERIFIER_B64 is not a SCRAM-SHA-256 verifier');
  }
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  if (exists.rowCount === 0)
    throw new Error(`role ${ROLE} does not exist: deploy the API so migration 0004 runs first`);

  // ALTER ROLE takes no bind parameters; the verifier is checked above and quoted as a literal.
  await client.query(
    action === 'rotate'
      ? `ALTER ROLE ${ROLE} WITH LOGIN PASSWORD ${client.escapeLiteral(verifier)}`
      : `ALTER ROLE ${ROLE} WITH NOLOGIN PASSWORD NULL`,
  );

  const [role] = (
    await client.query(
      `SELECT rolcanlogin AS can_login, rolconnlimit AS connection_limit, rolconfig AS config,
              (SELECT array_agg(v) FROM unnest($2::text[]) v WHERE NOT has_table_privilege($1::name, v, 'SELECT')) AS views_not_readable,
              (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
                WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
                  AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
                  AND c.relname <> ALL ($2::text[]) AND has_table_privilege($1::name, c.oid, 'SELECT')) AS other_readable
         FROM pg_roles WHERE rolname = $1`,
      [ROLE, VIEWS],
    )
  ).rows;
  const result = {
    action,
    role: ROLE,
    db: `${process.env.DB_HOST}/${process.env.DB_NAME}`,
    schema: (await client.query('SELECT current_schema() AS s')).rows[0].s,
    ...role,
  };
  result.pass =
    role.can_login === (action === 'rotate') && role.views_not_readable === null && role.other_readable === null;
  console.log(`REPORTING_ROLE_RESULT ${JSON.stringify(result)}`);
  await client.end();
})().catch((e) => {
  console.log(`REPORTING_ROLE_RESULT ${JSON.stringify({ error: e.message })}`);
  process.exit(1);
});
