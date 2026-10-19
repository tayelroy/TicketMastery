-- 0001_uc5_concerts_ticket_types_seats.sql
-- Owner: Elroy (UC5 Concert & Ticket Management). Seat hold columns are the contract for UC4 (Shi Hui).
--
-- Concerts, ticket types, seat layout (sections -> rows -> seats) and per-seat inventory state.
-- Applied by src/db/migrate.ts inside one transaction; do not add BEGIN/COMMIT here.
-- NEVER edit this file once merged: the runner checksums it. Add a new migration instead.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() (also built in since PG13)

CREATE TYPE concert_status AS ENUM ('draft', 'scheduled', 'on_sale', 'sold_out', 'cancelled', 'completed');
CREATE TYPE seat_status    AS ENUM ('available', 'held', 'sold');

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- concerts (venue kept as plain columns; no venues table yet)
-- ---------------------------------------------------------------------------
CREATE TABLE concerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id        text NOT NULL,                       -- Cognito `sub` of the owning organiser
  title               text NOT NULL CHECK (btrim(title) <> ''),
  artist              text NOT NULL CHECK (btrim(artist) <> ''),
  description         text,
  venue_name          text NOT NULL CHECK (btrim(venue_name) <> ''),
  venue_address       text,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz,
  sale_starts_at      timestamptz NOT NULL,
  sale_ends_at        timestamptz NOT NULL,
  status              concert_status NOT NULL DEFAULT 'draft',
  layout_locked_at    timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  image_url           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concerts_sale_window_chk     CHECK (sale_ends_at > sale_starts_at),
  CONSTRAINT concerts_sale_before_show_chk CHECK (sale_ends_at <= starts_at),
  CONSTRAINT concerts_ends_after_start_chk CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT concerts_cancelled_chk       CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX concerts_organiser_idx ON concerts (organiser_id, starts_at);
-- UC1 public listing (published, not cancelled/completed).
CREATE INDEX concerts_public_listing_idx ON concerts (starts_at) WHERE status IN ('scheduled', 'on_sale', 'sold_out');

CREATE TRIGGER concerts_set_updated_at BEFORE UPDATE ON concerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ticket_types
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_types (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concert_id    uuid NOT NULL REFERENCES concerts (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (btrim(name) <> ''),
  description   text,
  price_cents   integer NOT NULL CHECK (price_cents >= 0),
  currency      char(3) NOT NULL DEFAULT 'SGD' CHECK (currency ~ '^[A-Z]{3}$'),
  quantity      integer NOT NULL CHECK (quantity > 0),
  max_per_order integer NOT NULL DEFAULT 4 CHECK (max_per_order > 0),
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_types_concert_name_key UNIQUE (concert_id, name),
  -- Target for seats' composite FK so a seat cannot point at another concert's ticket type.
  CONSTRAINT ticket_types_id_concert_key UNIQUE (id, concert_id)
);

CREATE TRIGGER ticket_types_set_updated_at BEFORE UPDATE ON ticket_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Seat layout: sections -> rows -> seats
-- ---------------------------------------------------------------------------
CREATE TABLE sections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concert_id uuid NOT NULL REFERENCES concerts (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sections_concert_name_key UNIQUE (concert_id, name),
  CONSTRAINT sections_id_concert_key UNIQUE (id, concert_id)
);

CREATE TABLE rows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  label      text NOT NULL CHECK (btrim(label) <> ''),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rows_section_label_key UNIQUE (section_id, label),
  CONSTRAINT rows_id_section_key UNIQUE (id, section_id)
);

CREATE TABLE seats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised from sections so per-concert seat queries (seat map, holds, dashboard) hit one table.
  concert_id      uuid NOT NULL REFERENCES concerts (id) ON DELETE CASCADE,
  section_id      uuid NOT NULL,
  row_id          uuid NOT NULL,
  ticket_type_id  uuid NOT NULL,
  seat_number     text NOT NULL CHECK (btrim(seat_number) <> ''),
  status          seat_status NOT NULL DEFAULT 'available',
  held_by         text,          -- fan Cognito `sub`
  hold_id         uuid,          -- groups the seats of one checkout attempt
  held_at         timestamptz,
  hold_expires_at timestamptz,
  sold_at         timestamptz,
  order_id        uuid,          -- no FK yet: the orders table belongs to UC4 (Shi Hui)
  version         integer NOT NULL DEFAULT 0, -- bumped on every update (optimistic-concurrency token)
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seats_row_seat_number_key UNIQUE (row_id, seat_number),
  -- Composite FKs keep the denormalised concert_id/section_id consistent with the hierarchy.
  CONSTRAINT seats_section_fk FOREIGN KEY (section_id, concert_id)
    REFERENCES sections (id, concert_id) ON DELETE CASCADE,
  CONSTRAINT seats_row_fk FOREIGN KEY (row_id, section_id)
    REFERENCES rows (id, section_id) ON DELETE CASCADE,
  -- NO ACTION (not RESTRICT): deleting a ticket type that still has seats fails, but the check runs at
  -- end of statement, so cascading a whole concert delete (seats + ticket types together) succeeds.
  CONSTRAINT seats_ticket_type_fk FOREIGN KEY (ticket_type_id, concert_id)
    REFERENCES ticket_types (id, concert_id) ON DELETE NO ACTION,
  CONSTRAINT seats_available_chk CHECK (
    status <> 'available' OR (
      held_by IS NULL AND hold_id IS NULL AND held_at IS NULL AND hold_expires_at IS NULL
      AND sold_at IS NULL AND order_id IS NULL)),
  CONSTRAINT seats_held_chk CHECK (
    status <> 'held' OR (
      held_by IS NOT NULL AND hold_id IS NOT NULL AND held_at IS NOT NULL AND hold_expires_at IS NOT NULL
      AND sold_at IS NULL)),
  -- TODO(UC4): also require order_id IS NOT NULL once the orders table exists and confirm always sets it.
  CONSTRAINT seats_sold_chk CHECK (status <> 'sold' OR sold_at IS NOT NULL),
  CONSTRAINT seats_hold_window_chk CHECK (hold_expires_at IS NULL OR held_at IS NULL OR hold_expires_at > held_at)
);

CREATE INDEX seats_concert_status_idx ON seats (concert_id, status);
CREATE INDEX seats_held_expiry_idx    ON seats (hold_expires_at) WHERE status = 'held'; -- expired-hold sweeper
CREATE INDEX seats_hold_id_idx        ON seats (hold_id) WHERE hold_id IS NOT NULL;   -- confirm/release by hold
CREATE INDEX seats_ticket_type_idx    ON seats (ticket_type_id);
CREATE INDEX seats_section_idx        ON seats (section_id, concert_id);               -- FK cascade from sections

CREATE FUNCTION seats_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER seats_touch BEFORE UPDATE ON seats
  FOR EACH ROW EXECUTE FUNCTION seats_touch();

-- ---------------------------------------------------------------------------
-- Layout lock
--
-- Once a concert's sale has opened (or it was explicitly locked / is on sale / finished / cancelled), its
-- ticket types and seat layout are frozen. Seat *status/hold* updates stay allowed: checkout needs them.
-- The API checks the same predicate first (for a friendly 409); these triggers are the backstop.
-- ---------------------------------------------------------------------------
CREATE FUNCTION concert_layout_locked(
  p_status concert_status, p_sale_starts_at timestamptz, p_layout_locked_at timestamptz
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_layout_locked_at IS NOT NULL
      OR p_sale_starts_at <= now()
      OR p_status IN ('on_sale', 'sold_out', 'cancelled', 'completed')
$$;

CREATE FUNCTION assert_layout_unlocked(p_concert_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  c concerts%ROWTYPE;
BEGIN
  IF p_concert_id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO c FROM concerts WHERE id = p_concert_id;
  -- Not found: the concert itself is being deleted (cascade), which concerts_guard_delete already vetted.
  IF FOUND AND concert_layout_locked(c.status, c.sale_starts_at, c.layout_locked_at) THEN
    RAISE EXCEPTION 'layout locked: concert % (status %) can no longer change ticket types or seat layout',
      p_concert_id, c.status
      USING ERRCODE = 'P0001', HINT = 'Ticket types and layout lock when the sale opens.';
  END IF;
END
$$;

CREATE FUNCTION enforce_layout_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'rows' THEN
    -- rows has no concert_id; resolve via the section (absent during a section cascade -> allowed).
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM assert_layout_unlocked((SELECT concert_id FROM sections WHERE id = OLD.section_id));
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM assert_layout_unlocked((SELECT concert_id FROM sections WHERE id = NEW.section_id));
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM assert_layout_unlocked(OLD.concert_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM assert_layout_unlocked(NEW.concert_id);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER sections_layout_lock BEFORE INSERT OR UPDATE OR DELETE ON sections
  FOR EACH ROW EXECUTE FUNCTION enforce_layout_lock();

CREATE TRIGGER rows_layout_lock BEFORE INSERT OR UPDATE OR DELETE ON rows
  FOR EACH ROW EXECUTE FUNCTION enforce_layout_lock();

CREATE TRIGGER ticket_types_layout_lock_insert_delete BEFORE INSERT OR DELETE ON ticket_types
  FOR EACH ROW EXECUTE FUNCTION enforce_layout_lock();

-- description / sort_order / max_per_order stay editable after lock; inventory and pricing do not.
CREATE TRIGGER ticket_types_layout_lock_update BEFORE UPDATE ON ticket_types
  FOR EACH ROW
  WHEN (OLD.concert_id IS DISTINCT FROM NEW.concert_id
     OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.price_cents IS DISTINCT FROM NEW.price_cents
     OR OLD.currency IS DISTINCT FROM NEW.currency
     OR OLD.quantity IS DISTINCT FROM NEW.quantity)
  EXECUTE FUNCTION enforce_layout_lock();

CREATE TRIGGER seats_layout_lock_insert_delete BEFORE INSERT OR DELETE ON seats
  FOR EACH ROW EXECUTE FUNCTION enforce_layout_lock();

-- The WHEN clause keeps the checkout hot path (status/hold updates) free of any trigger call.
CREATE TRIGGER seats_layout_lock_update BEFORE UPDATE ON seats
  FOR EACH ROW
  WHEN (OLD.concert_id IS DISTINCT FROM NEW.concert_id
     OR OLD.section_id IS DISTINCT FROM NEW.section_id
     OR OLD.row_id IS DISTINCT FROM NEW.row_id
     OR OLD.ticket_type_id IS DISTINCT FROM NEW.ticket_type_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number)
  EXECUTE FUNCTION enforce_layout_lock();

-- Concert rows: status changes (publish, cancel, on_sale, ...) stay allowed after lock, but a locked
-- concert cannot be deleted, unlocked, have its sale start moved, or leave cancelled/completed.
CREATE FUNCTION concerts_guard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF concert_layout_locked(OLD.status, OLD.sale_starts_at, OLD.layout_locked_at) THEN
    RAISE EXCEPTION 'layout locked: concert % (status %) cannot be deleted; cancel it instead', OLD.id, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER concerts_guard_delete BEFORE DELETE ON concerts
  FOR EACH ROW EXECUTE FUNCTION concerts_guard_delete();

CREATE FUNCTION concerts_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('cancelled', 'completed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'concert % is % and cannot change status', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF concert_layout_locked(OLD.status, OLD.sale_starts_at, OLD.layout_locked_at) THEN
    IF OLD.layout_locked_at IS NOT NULL AND NEW.layout_locked_at IS NULL THEN
      RAISE EXCEPTION 'layout locked: concert % cannot be unlocked', OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.sale_starts_at IS DISTINCT FROM OLD.sale_starts_at THEN
      RAISE EXCEPTION 'layout locked: concert % sale start cannot change after lock', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER concerts_guard_update BEFORE UPDATE ON concerts
  FOR EACH ROW EXECUTE FUNCTION concerts_guard_update();

-- ---------------------------------------------------------------------------
-- Organiser dashboard counts (UC5). Expired holds count as available because any checkout can reclaim them
-- immediately; `held_expired` is the subset of `available` still waiting for the sweeper.
-- ---------------------------------------------------------------------------
CREATE VIEW concert_seat_counts AS
SELECT
  s.concert_id,
  s.ticket_type_id,
  count(*) FILTER (WHERE s.status = 'available' OR (s.status = 'held' AND s.hold_expires_at < now()))  AS available,
  count(*) FILTER (WHERE s.status = 'held' AND s.hold_expires_at >= now())                             AS held_active,
  count(*) FILTER (WHERE s.status = 'held' AND s.hold_expires_at < now())                              AS held_expired,
  count(*) FILTER (WHERE s.status = 'sold')                                                            AS sold,
  count(*)                                                                                              AS total
FROM seats s
GROUP BY s.concert_id, s.ticket_type_id;

-- ===========================================================================
-- CANONICAL SEAT-HOLD STATEMENTS (contract for UC4 checkout; reference implementation in
-- src/db/seat-holds.ts, exercised by test/seat-inventory.test.ts)
--
-- 1. HOLD (all-or-nothing, 10 minutes). Run inside a transaction:
--
--      BEGIN;
--      UPDATE seats
--         SET status = 'held', held_by = $fan, hold_id = $hold,
--             held_at = now(), hold_expires_at = now() + interval '10 minutes'
--       WHERE concert_id = $c
--         AND id = ANY($seat_ids::uuid[])
--         AND (status = 'available' OR (status = 'held' AND hold_expires_at < now()))
--      RETURNING id;
--      -- if rowCount <> cardinality($seat_ids): ROLLBACK (some seat was taken; hold nothing)
--      -- else: COMMIT
--
--    Why two concurrent holds cannot both win (READ COMMITTED is enough): UPDATE takes a row lock on every
--    row it modifies. If transaction B reaches a row A has already updated, B blocks until A commits or
--    rolls back. Postgres then re-evaluates B's WHERE clause against the *new* row version (EvalPlanQual):
--    after A commits the seat is 'held' with a future expiry, so the predicate is false and B skips the
--    row. B's rowCount comes up short, so B rolls back and releases any seats it did get. No SELECT ...
--    FOR UPDATE or SERIALIZABLE needed. Pass seat ids sorted to keep lock order consistent and avoid
--    deadlocks between overlapping multi-seat holds (a deadlock just aborts one side, which is still safe).
--    Checkout should additionally verify the concert is on sale, e.g. AND EXISTS (SELECT 1 FROM concerts c
--    WHERE c.id = $c AND c.status = 'on_sale' AND now() BETWEEN c.sale_starts_at AND c.sale_ends_at).
--
-- 2. CONFIRM (payment succeeded; only the fan's own, unexpired hold):
--
--      UPDATE seats
--         SET status = 'sold', sold_at = now(), order_id = $order
--       WHERE hold_id = $hold AND held_by = $fan AND status = 'held' AND hold_expires_at > now()
--      RETURNING id;
--      -- if rowCount <> number of seats in the hold: ROLLBACK (hold expired / reclaimed)
--
-- 3. RELEASE (fan abandons checkout / payment failed):
--
--      UPDATE seats
--         SET status = 'available', held_by = NULL, hold_id = NULL, held_at = NULL, hold_expires_at = NULL
--       WHERE hold_id = $hold AND held_by = $fan AND status = 'held';
--
-- 4. SWEEP expired holds (EventBridge-scheduled; optional because holds are reclaimable anyway, but it
--    keeps the `status` column honest for reporting). Batched, skipping rows a checkout is touching:
--
--      UPDATE seats
--         SET status = 'available', held_by = NULL, hold_id = NULL, held_at = NULL, hold_expires_at = NULL
--       WHERE id IN (SELECT id FROM seats
--                     WHERE status = 'held' AND hold_expires_at < now()
--                     ORDER BY hold_expires_at
--                     LIMIT $batch
--                     FOR UPDATE SKIP LOCKED)
--         AND status = 'held' AND hold_expires_at < now();
-- ===========================================================================
