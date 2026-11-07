-- 0005_uc4_max_three_seats_per_order.sql
-- Owner: Shi Hui (UC4 Seat selection & checkout); changes UC5's ticket_types (reviewed by Elroy).
--
-- Product rule: a fan buys 1-3 seats per order. The API caps a hold at MAX_SEATS_PER_ORDER = 3
-- (src/modules/seat-limits.ts) and organisers cannot set max_per_order above it; this makes the database agree.
--   1. Clamp existing ticket types (the old default was 4, the old API maximum 20). max_per_order stays editable
--      after the layout lock (see ticket_types_layout_lock_update in 0001), so locked concerts are clamped too.
--      Orders already placed keep their seats; the limit applies to new holds.
--   2. New rows default to 3.
--   3. CHECK 1..3. 0001's CHECK (max_per_order > 0) stays; it is now redundant.
-- Applied by src/db/migrate.ts inside one transaction; do not add BEGIN/COMMIT here.
-- NEVER edit this file once merged: the runner checksums it. Add a new migration instead.

UPDATE ticket_types SET max_per_order = 3 WHERE max_per_order > 3;

ALTER TABLE ticket_types ALTER COLUMN max_per_order SET DEFAULT 3;

ALTER TABLE ticket_types
  ADD CONSTRAINT ticket_types_max_per_order_range CHECK (max_per_order BETWEEN 1 AND 3);
