-- 0002_uc4_orders.sql
-- Owner: Shi Hui (UC4 Seat selection & checkout).
--
-- Orders and their seats. An order is created as 'pending' together with the 10-minute seat hold, so the
-- price the fan sees (and pays) is fixed at hold time, even if the organiser changes prices later.
--   pending   -> confirmed  (simulated payment succeeded; seats sold, seats.order_id set)
--   pending   -> cancelled  (fan released the hold or payment failed; seats released)
--   pending   -> expired    (hold ran out; set when the fan releases/confirms it or starts a new hold, or by
--                            whoever tidies expired holds)
-- published_at: set once SNS has accepted OrderConfirmed. A confirmed order with published_at NULL has not
-- reached the e-ticket pipeline yet; confirming it again re-publishes.
-- Applied by src/db/migrate.ts inside one transaction; do not add BEGIN/COMMIT here.
-- NEVER edit this file once merged: the runner checksums it. Add a new migration instead.

CREATE TYPE order_status AS ENUM ('pending', 'confirmed', 'cancelled', 'expired');

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id            text NOT NULL,                        -- Cognito `sub` of the buyer
  concert_id        uuid NOT NULL REFERENCES concerts (id),
  hold_id           uuid NOT NULL,                        -- seats.hold_id of this checkout attempt
  status            order_status NOT NULL DEFAULT 'pending',
  currency          char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Money in cents, snapshotted at hold time. Fee shown separately on the checkout page and in UC2 history.
  subtotal_cents    integer NOT NULL CHECK (subtotal_cents >= 0),
  booking_fee_cents integer NOT NULL CHECK (booking_fee_cents >= 0),
  total_cents       integer NOT NULL,
  expires_at        timestamptz NOT NULL,                 -- same instant as the seats' hold_expires_at
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  published_at      timestamptz,                          -- OrderConfirmed accepted by SNS
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_hold_id_key        UNIQUE (hold_id),
  CONSTRAINT orders_total_chk          CHECK (total_cents = subtotal_cents + booking_fee_cents),
  CONSTRAINT orders_confirmed_chk      CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT orders_cancelled_chk      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT orders_published_chk      CHECK (published_at IS NULL OR status = 'confirmed')
);

-- UC2 order history ("my orders, newest first") and UC4's "one active hold per fan per concert" check.
CREATE INDEX orders_fan_idx     ON orders (fan_id, created_at DESC);
CREATE INDEX orders_pending_idx ON orders (fan_id, concert_id) WHERE status = 'pending';
CREATE INDEX orders_concert_idx ON orders (concert_id, status);
-- Confirmed orders whose OrderConfirmed never reached SNS (for re-publishing).
CREATE INDEX orders_unpublished_idx ON orders (confirmed_at) WHERE status = 'confirmed' AND published_at IS NULL;

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per seat in the order, with the ticket type and price at hold time.
CREATE TABLE order_items (
  order_id       uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  seat_id        uuid NOT NULL REFERENCES seats (id),
  ticket_type_id uuid NOT NULL REFERENCES ticket_types (id),
  price_cents    integer NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (order_id, seat_id)
);

CREATE INDEX order_items_seat_idx ON order_items (seat_id);

-- ---------------------------------------------------------------------------
-- Hand-off agreed in 0001 / migrations/README.md: seats.order_id now points at orders, and a sold seat must
-- name its order (0001 left this as TODO(UC4)).
-- ---------------------------------------------------------------------------
ALTER TABLE seats
  ADD CONSTRAINT seats_order_fk FOREIGN KEY (order_id) REFERENCES orders (id);

ALTER TABLE seats DROP CONSTRAINT seats_sold_chk;
ALTER TABLE seats
  ADD CONSTRAINT seats_sold_chk CHECK (status <> 'sold' OR (sold_at IS NOT NULL AND order_id IS NOT NULL));
