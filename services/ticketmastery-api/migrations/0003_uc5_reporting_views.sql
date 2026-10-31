-- 0003_uc5_reporting_views.sql
-- Owner: Elroy (UC5 internal reporting). Reads UC4's orders/order_items; no table changes.
--
-- Read-only views for a BI tool (QuickSight in the design, see docs/reporting.md). Each view is a ready-made
-- dataset, so the BI side needs no custom SQL and only SELECT on these views. Every view carries organiser_id
-- so a dashboard can apply row-level security (an organiser sees only their own concerts).
-- Money is integer cents, summed as bigint, in the order's currency; amounts are never added across currencies.
-- Sales count confirmed orders only: pending, cancelled and expired checkout attempts are not sales. A concert
-- cancelled after its sales keeps them (no refunds exist yet); filter on concert_status to exclude it.
-- Applied by src/db/migrate.ts inside one transaction; do not add BEGIN/COMMIT here.
-- NEVER edit this file once merged: the runner checksums it. Add a new migration instead.

-- One row per confirmed order. The fact table the sales views aggregate, and a dataset in its own right.
-- No fan_id: reporting has no need for buyer identities.
CREATE VIEW report_confirmed_orders AS
SELECT
  o.id                                                       AS order_id,
  o.concert_id,
  c.organiser_id,
  o.currency,
  (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS seats,
  o.subtotal_cents                                           AS ticket_revenue_cents,
  o.booking_fee_cents,
  o.total_cents                                              AS gross_revenue_cents,
  o.confirmed_at,
  -- Organisers and fans think in Singapore days; AT TIME ZONE keeps this independent of the session TimeZone.
  (o.confirmed_at AT TIME ZONE 'Asia/Singapore')::date       AS sale_date_sgt
FROM orders o
JOIN concerts c ON c.id = o.concert_id
WHERE o.status = 'confirmed';

-- Per concert and currency: orders, seats, face-value ticket revenue, booking fees and gross (what fans paid).
CREATE VIEW report_sales_by_concert AS
SELECT
  c.id                         AS concert_id,
  c.organiser_id,
  c.title                      AS concert_title,
  c.artist,
  c.venue_name,
  c.starts_at                  AS concert_starts_at,
  c.status                     AS concert_status,
  r.currency,
  count(*)                     AS confirmed_orders,
  sum(r.seats)::bigint         AS seats_sold,
  sum(r.ticket_revenue_cents)  AS ticket_revenue_cents,
  sum(r.booking_fee_cents)     AS booking_fee_cents,
  sum(r.gross_revenue_cents)   AS gross_revenue_cents
FROM report_confirmed_orders r
JOIN concerts c ON c.id = r.concert_id
GROUP BY c.id, r.currency;

-- Per ticket type and currency, from the seat prices snapshotted at hold time. The booking fee is charged per
-- order, not per ticket type, so it is only in the concert and day views.
CREATE VIEW report_sales_by_ticket_type AS
SELECT
  c.id                         AS concert_id,
  c.organiser_id,
  c.title                      AS concert_title,
  tt.id                        AS ticket_type_id,
  tt.name                      AS ticket_type_name,
  tt.sort_order                AS ticket_type_sort_order,
  o.currency,
  count(DISTINCT o.id)         AS confirmed_orders,
  count(*)                     AS seats_sold,
  sum(i.price_cents)           AS ticket_revenue_cents
FROM orders o
JOIN order_items i   ON i.order_id = o.id
JOIN ticket_types tt ON tt.id = i.ticket_type_id
JOIN concerts c      ON c.id = o.concert_id
WHERE o.status = 'confirmed'
GROUP BY c.id, tt.id, o.currency;

-- Per Singapore calendar day of payment (confirmed_at), concert and currency. Days without sales have no row.
CREATE VIEW report_sales_by_day AS
SELECT
  r.sale_date_sgt              AS sale_date,
  c.id                         AS concert_id,
  c.organiser_id,
  c.title                      AS concert_title,
  r.currency,
  count(*)                     AS confirmed_orders,
  sum(r.seats)::bigint         AS seats_sold,
  sum(r.ticket_revenue_cents)  AS ticket_revenue_cents,
  sum(r.booking_fee_cents)     AS booking_fee_cents,
  sum(r.gross_revenue_cents)   AS gross_revenue_cents
FROM report_confirmed_orders r
JOIN concerts c ON c.id = r.concert_id
GROUP BY r.sale_date_sgt, c.id, r.currency;

-- Per concert, every concert including drafts without a layout (all zero). Same definitions as the live
-- dashboard's concert_seat_counts (0001): an expired hold counts as available because checkout can reclaim it
-- at once, so `held` is active holds only. Counts are as of the query (or the BI tool's last refresh).
CREATE VIEW report_seat_status AS
SELECT
  c.id                                        AS concert_id,
  c.organiser_id,
  c.title                                     AS concert_title,
  c.starts_at                                 AS concert_starts_at,
  c.status                                    AS concert_status,
  COALESCE(sum(sc.available), 0)::bigint      AS available,
  COALESCE(sum(sc.held_active), 0)::bigint    AS held,
  COALESCE(sum(sc.sold), 0)::bigint           AS sold,
  COALESCE(sum(sc.total), 0)::bigint          AS total
FROM concerts c
LEFT JOIN concert_seat_counts sc ON sc.concert_id = c.id
GROUP BY c.id;
