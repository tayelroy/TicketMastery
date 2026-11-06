-- 0004_uc5_reporting_role.sql
-- Owner: Elroy (UC5 internal reporting). No table changes.
--
-- Database role for QuickSight (infra/modules/quicksight): SELECT on the five report_* views from 0003 and nothing
-- else. Views run with their owner's privileges, so the role needs no grant on orders, seats or any other table and
-- cannot see fan ids or hold details.
-- Created NOLOGIN and without a password, so no secret is in git: loadtest/scripts/reporting-user.sh later sets
-- LOGIN and a generated password through ECS Exec and stores the credentials in Secrets Manager for QuickSight.
-- Roles are cluster-wide, not per schema: the role is created once (the tests' throwaway schemas reuse it), while
-- the grants are on the schema this runs in (current_schema(): `public` on RDS).
-- CONNECT on the database is not granted here: PUBLIC has it by default.
-- Applied by src/db/migrate.ts inside one transaction; do not add BEGIN/COMMIT here.
-- NEVER edit this file once merged: the runner checksums it. Add a new migration instead.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reporting_ro') THEN
    -- QuickSight direct query runs about one query per visual; the Sales sheet has five visuals.
    CREATE ROLE reporting_ro NOLOGIN CONNECTION LIMIT 10;
    -- Defence in depth: every session of this role is read-only, even if a write grant is added by mistake.
    ALTER ROLE reporting_ro SET default_transaction_read_only = on;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO reporting_ro', current_schema());
END
$$;

GRANT SELECT ON report_confirmed_orders, report_sales_by_concert, report_sales_by_ticket_type, report_sales_by_day,
  report_seat_status TO reporting_ro;
