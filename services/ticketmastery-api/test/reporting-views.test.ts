/**
 * Integration tests for the UC5 reporting views (migrations/0003_uc5_reporting_views.sql) that a BI tool reads.
 * Sales are made by the real UC5 + UC4 services (publish, hold, pay, release, decline), so these tests break if
 * UC4's tables or statuses change under the views. Only confirmed_at is moved afterwards, to pin the Singapore
 * day boundary. Needs a real Postgres, like account.test.ts: skipped when DB_HOST is unset, and everything runs
 * in a throwaway schema that is dropped at the end. The reporting_ro tests (0004) also need a superuser connection,
 * as in docker-compose, to SET ROLE.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type * as PoolModule from "../src/db/pool";
import type * as CheckoutServiceModule from "../src/modules/checkout/service";
import type * as OrganiserServiceModule from "../src/modules/organiser/service";

const schema = `tm_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const ORGANISER = "org-report";
const OTHER_ORGANISER = "org-other";

type TicketTypeInput = {
  name: string;
  priceCents: number;
  currency: string;
  quantity: number;
  maxPerOrder: number;
};
type RowInput = {
  label: string;
  ticketTypeName: string;
  seats: { from: number; to: number };
};

describe(
  "UC5 reporting views (Postgres)",
  { skip: process.env.DB_HOST ? false : "DB_HOST not set" },
  () => {
    // Dynamic imports for the same reason as checkout.test.ts (config validation + PGOPTIONS).
    let db: typeof PoolModule;
    let organiser: typeof OrganiserServiceModule;
    let checkout: typeof CheckoutServiceModule;
    let appliedMigrations: string[];

    const concert: Record<"x" | "y" | "z", { id: string; startsAt: string }> =
      {} as never;

    /** A published concert with an open sale. Returns its id, start and seat ids by label (row + number). */
    async function createOnSaleConcert(
      organiserId: string,
      title: string,
      ticketTypes: TicketTypeInput[],
      rows: RowInput[],
    ) {
      const day = 24 * 60 * 60 * 1000;
      const created = await organiser.createConcert(organiserId, {
        title,
        artist: "Test Artist",
        venueName: "Test Hall",
        saleStartsAt: new Date(Date.now() + day).toISOString(),
        saleEndsAt: new Date(Date.now() + 2 * day).toISOString(),
        startsAt: new Date(Date.now() + 3 * day).toISOString(),
      });
      await organiser.replaceTicketTypes(organiserId, created.id, {
        ticketTypes,
      });
      await organiser.replaceLayout(organiserId, created.id, {
        sections: [{ name: "Floor", rows }],
      });
      await organiser.publishConcert(organiserId, created.id);
      await db.query(
        `UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = $1`,
        [created.id],
      );
      const { rows: seats } = await db.query<{ id: string; label: string }>(
        `SELECT s.id, r.label || s.seat_number AS label FROM seats s JOIN rows r ON r.id = s.row_id
        WHERE s.concert_id = $1`,
        [created.id],
      );
      return {
        id: created.id,
        startsAt: new Date(created.startsAt).toISOString(),
        seat: Object.fromEntries(seats.map((s) => [s.label, s.id])) as Record<
          string,
          string
        >,
      };
    }

    /** Holds and pays like the checkout page, then pins when the payment happened. */
    async function buy(
      fanId: string,
      concertId: string,
      seatIds: string[],
      confirmedAt: string,
    ) {
      const hold = await checkout.createHold(fanId, { concertId, seatIds });
      await checkout.confirmHold(fanId, hold.holdId, {
        simulatePaymentFailure: false,
      });
      await db.query("UPDATE orders SET confirmed_at = $2 WHERE hold_id = $1", [
        hold.holdId,
        confirmedAt,
      ]);
    }

    /**
     * Every row of a view as plain JSON (bigints as numbers, dates as YYYY-MM-DD), so assertions compare whole rows.
     * Timestamps come back in the session time zone; they are normalised to UTC ISO strings here.
     */
    async function rowsOf(view: string, orderBy: string) {
      const { rows } = await db.query<{ r: Record<string, unknown> }>(
        `SELECT row_to_json(v) AS r FROM ${view} v ORDER BY ${orderBy}`,
      );
      return rows.map(({ r }) => {
        for (const key of ["concert_starts_at", "confirmed_at"]) {
          if (typeof r[key] === "string")
            r[key] = new Date(r[key] as string).toISOString();
        }
        return r;
      });
    }

    before(async () => {
      process.env.PGOPTIONS = `-c search_path=${schema},public`;
      Object.assign(process.env, {
        AUTH_MODE: "dev-header",
        LOG_LEVEL: "silent",
      });

      db = await import("../src/db/pool.js");
      await db.query(`CREATE SCHEMA ${schema}`);
      appliedMigrations = (
        await (await import("../src/db/migrate.js")).runMigrations()
      ).applied;
      organiser = await import("../src/modules/organiser/service.js");
      checkout = await import("../src/modules/checkout/service.js");

      // X: two SGD ticket types and one USD type, so one concert has sales in two currencies.
      const x = await createOnSaleConcert(
        ORGANISER,
        "Report X",
        [
          {
            name: "GA",
            priceCents: 10_000,
            currency: "SGD",
            quantity: 10,
            maxPerOrder: 4,
          },
          {
            name: "VIP",
            priceCents: 25_000,
            currency: "SGD",
            quantity: 3,
            maxPerOrder: 2,
          },
          {
            name: "Overseas",
            priceCents: 8_000,
            currency: "USD",
            quantity: 2,
            maxPerOrder: 2,
          },
        ],
        [
          { label: "A", ticketTypeName: "VIP", seats: { from: 1, to: 3 } },
          { label: "B", ticketTypeName: "GA", seats: { from: 1, to: 10 } },
          { label: "C", ticketTypeName: "Overseas", seats: { from: 1, to: 2 } },
        ],
      );
      concert.x = x;
      // 23:59:59 and 00:00:00 Singapore time (UTC+8): the first order is on 1 Nov, the second on 2 Nov.
      await buy(
        "fan-a",
        x.id,
        [x.seat.B1!, x.seat.B2!, x.seat.A1!],
        "2026-11-01T15:59:59Z",
      );
      await buy("fan-b", x.id, [x.seat.B3!], "2026-11-01T16:00:00Z");
      await buy("fan-c", x.id, [x.seat.A2!], "2026-11-02T03:00:00Z");
      await buy("fan-d", x.id, [x.seat.C1!], "2026-11-02T04:00:00Z");

      // Checkout attempts on X that are not sales.
      await checkout.createHold("fan-e", {
        concertId: x.id,
        seatIds: [x.seat.B4!],
      }); // active hold: held
      const lapsed = await checkout.createHold("fan-f", {
        concertId: x.id,
        seatIds: [x.seat.B5!],
      });
      // A hold that ran out but nobody has tidied: still 'held' in the table, reported as available.
      await db.query(
        `UPDATE seats SET held_at = now() - interval '20 minutes', hold_expires_at = now() - interval '10 minutes'
        WHERE hold_id = $1`,
        [lapsed.holdId],
      );
      await db.query(
        `UPDATE orders SET expires_at = now() - interval '10 minutes' WHERE hold_id = $1`,
        [lapsed.holdId],
      );
      const released = await checkout.createHold("fan-g", {
        concertId: x.id,
        seatIds: [x.seat.B6!],
      });
      await checkout.releaseHold("fan-g", released.holdId);
      const declined = await checkout.createHold("fan-h", {
        concertId: x.id,
        seatIds: [x.seat.B7!],
      });
      await assert.rejects(
        checkout.confirmHold("fan-h", declined.holdId, {
          simulatePaymentFailure: true,
        }),
      );

      // Y: another organiser's concert, cancelled after one sale. The sale stays in the reports.
      const y = await createOnSaleConcert(
        OTHER_ORGANISER,
        "Report Y",
        [
          {
            name: "GA",
            priceCents: 5_000,
            currency: "SGD",
            quantity: 4,
            maxPerOrder: 4,
          },
        ],
        [{ label: "A", ticketTypeName: "GA", seats: { from: 1, to: 4 } }],
      );
      concert.y = y;
      await buy("fan-a", y.id, [y.seat.A1!], "2026-11-01T02:00:00Z");
      await organiser.cancelConcert(OTHER_ORGANISER, y.id, "Venue unavailable");

      // Z: a draft without ticket types or layout.
      const z = await organiser.createConcert(ORGANISER, {
        title: "Report Z",
        artist: "Test Artist",
        venueName: "Test Hall",
        saleStartsAt: "2027-01-01T00:00:00Z",
        saleEndsAt: "2027-01-02T00:00:00Z",
        startsAt: "2027-01-03T00:00:00Z",
      });
      concert.z = { id: z.id, startsAt: new Date(z.startsAt).toISOString() };
    });

    after(async () => {
      await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db?.pool.end();
    });

    test("runMigrations applies 0003 on a fresh schema", () => {
      assert.ok(
        appliedMigrations.includes("0003_uc5_reporting_views.sql"),
        appliedMigrations.join(", "),
      );
    });

    test("report_confirmed_orders: one row per confirmed order, with its Singapore sale date", async () => {
      const rows = await rowsOf("report_confirmed_orders", "v.confirmed_at");
      assert.deepEqual(
        rows.map(({ order_id, ...rest }) => {
          assert.match(order_id as string, /^[0-9a-f-]{36}$/);
          return rest;
        }),
        [
          {
            concert_id: concert.y.id,
            organiser_id: OTHER_ORGANISER,
            currency: "SGD",
            seats: 1,
            ticket_revenue_cents: 5_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 5_400,
            confirmed_at: "2026-11-01T02:00:00.000Z",
            sale_date_sgt: "2026-11-01",
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            currency: "SGD",
            seats: 3,
            ticket_revenue_cents: 45_000,
            booking_fee_cents: 1_200,
            gross_revenue_cents: 46_200,
            confirmed_at: "2026-11-01T15:59:59.000Z",
            sale_date_sgt: "2026-11-01",
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            currency: "SGD",
            seats: 1,
            ticket_revenue_cents: 10_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 10_400,
            confirmed_at: "2026-11-01T16:00:00.000Z",
            sale_date_sgt: "2026-11-02",
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            currency: "SGD",
            seats: 1,
            ticket_revenue_cents: 25_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 25_400,
            confirmed_at: "2026-11-02T03:00:00.000Z",
            sale_date_sgt: "2026-11-02",
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            currency: "USD",
            seats: 1,
            ticket_revenue_cents: 8_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 8_400,
            confirmed_at: "2026-11-02T04:00:00.000Z",
            sale_date_sgt: "2026-11-02",
          },
        ],
      );
    });

    test("report_sales_by_concert: confirmed orders only, split by currency, cancelled concerts kept", async () => {
      const concertColumns = (
        c: { id: string; startsAt: string },
        organiserId: string,
        title: string,
        status: string,
      ) => ({
        concert_id: c.id,
        organiser_id: organiserId,
        concert_title: title,
        artist: "Test Artist",
        venue_name: "Test Hall",
        concert_starts_at: c.startsAt,
        concert_status: status,
      });
      assert.deepEqual(
        await rowsOf("report_sales_by_concert", "v.concert_title, v.currency"),
        [
          {
            ...concertColumns(concert.x, ORGANISER, "Report X", "scheduled"),
            currency: "SGD",
            confirmed_orders: 3,
            seats_sold: 5,
            ticket_revenue_cents: 80_000,
            booking_fee_cents: 2_000,
            gross_revenue_cents: 82_000,
          },
          {
            ...concertColumns(concert.x, ORGANISER, "Report X", "scheduled"),
            currency: "USD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 8_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 8_400,
          },
          {
            ...concertColumns(
              concert.y,
              OTHER_ORGANISER,
              "Report Y",
              "cancelled",
            ),
            currency: "SGD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 5_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 5_400,
          },
        ],
      );
    });

    test("report_sales_by_ticket_type: seats and face value per ticket type", async () => {
      const rows = await rowsOf(
        "report_sales_by_ticket_type",
        "v.concert_title, v.ticket_type_sort_order",
      );
      assert.deepEqual(
        rows.map(({ ticket_type_id, ...rest }) => {
          assert.match(ticket_type_id as string, /^[0-9a-f-]{36}$/);
          return rest;
        }),
        [
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            concert_title: "Report X",
            ticket_type_name: "GA",
            ticket_type_sort_order: 0,
            currency: "SGD",
            confirmed_orders: 2,
            seats_sold: 3,
            ticket_revenue_cents: 30_000,
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            concert_title: "Report X",
            ticket_type_name: "VIP",
            ticket_type_sort_order: 1,
            currency: "SGD",
            confirmed_orders: 2,
            seats_sold: 2,
            ticket_revenue_cents: 50_000,
          },
          {
            concert_id: concert.x.id,
            organiser_id: ORGANISER,
            concert_title: "Report X",
            ticket_type_name: "Overseas",
            ticket_type_sort_order: 2,
            currency: "USD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 8_000,
          },
          {
            concert_id: concert.y.id,
            organiser_id: OTHER_ORGANISER,
            concert_title: "Report Y",
            ticket_type_name: "GA",
            ticket_type_sort_order: 0,
            currency: "SGD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 5_000,
          },
        ],
      );
    });

    test("report_sales_by_day: grouped by Singapore calendar day of payment", async () => {
      const x = {
        concert_id: concert.x.id,
        organiser_id: ORGANISER,
        concert_title: "Report X",
      };
      assert.deepEqual(
        await rowsOf(
          "report_sales_by_day",
          "v.sale_date, v.concert_title, v.currency",
        ),
        [
          {
            sale_date: "2026-11-01",
            ...x,
            currency: "SGD",
            confirmed_orders: 1,
            seats_sold: 3,
            ticket_revenue_cents: 45_000,
            booking_fee_cents: 1_200,
            gross_revenue_cents: 46_200,
          },
          {
            sale_date: "2026-11-01",
            concert_id: concert.y.id,
            organiser_id: OTHER_ORGANISER,
            concert_title: "Report Y",
            currency: "SGD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 5_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 5_400,
          },
          {
            sale_date: "2026-11-02",
            ...x,
            currency: "SGD",
            confirmed_orders: 2,
            seats_sold: 2,
            ticket_revenue_cents: 35_000,
            booking_fee_cents: 800,
            gross_revenue_cents: 35_800,
          },
          {
            sale_date: "2026-11-02",
            ...x,
            currency: "USD",
            confirmed_orders: 1,
            seats_sold: 1,
            ticket_revenue_cents: 8_000,
            booking_fee_cents: 400,
            gross_revenue_cents: 8_400,
          },
        ],
      );
    });

    test("report_seat_status: every concert; lapsed holds count as available", async () => {
      assert.deepEqual(await rowsOf("report_seat_status", "v.concert_title"), [
        {
          concert_id: concert.x.id,
          organiser_id: ORGANISER,
          concert_title: "Report X",
          concert_starts_at: concert.x.startsAt,
          concert_status: "scheduled",
          // Sold: B1-3, A1-2, C1. Held: B4. Available: the lapsed B5, released B6, declined B7, B8-10, A3, C2.
          available: 8,
          held: 1,
          sold: 6,
          total: 15,
        },
        {
          concert_id: concert.y.id,
          organiser_id: OTHER_ORGANISER,
          concert_title: "Report Y",
          concert_starts_at: concert.y.startsAt,
          concert_status: "cancelled",
          available: 3,
          held: 0,
          sold: 1,
          total: 4,
        },
        {
          concert_id: concert.z.id,
          organiser_id: ORGANISER,
          concert_title: "Report Z",
          concert_starts_at: concert.z.startsAt,
          concert_status: "draft",
          available: 0,
          held: 0,
          sold: 0,
          total: 0,
        },
      ]);
    });

    test("reporting_ro (0004): SELECT on the five report_* views and nothing else in the schema", async () => {
      assert.ok(
        appliedMigrations.includes("0004_uc5_reporting_role.sql"),
        appliedMigrations.join(", "),
      );
      const { rows } = await db.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c
          WHERE c.relnamespace = $1::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
            AND has_table_privilege('reporting_ro', c.oid, 'SELECT')`,
        [schema],
      );
      assert.deepEqual(rows.map((r) => r.relname).sort(), [
        "report_confirmed_orders",
        "report_sales_by_concert",
        "report_sales_by_day",
        "report_sales_by_ticket_type",
        "report_seat_status",
      ]);
      const role = await db.query<{ rolconfig: string[] | null }>(
        "SELECT rolconfig FROM pg_roles WHERE rolname = 'reporting_ro'",
      );
      assert.ok(
        role.rows[0]?.rolconfig?.includes("default_transaction_read_only=on"),
        JSON.stringify(role.rows),
      );
    });

    test("reporting_ro (0004): reads the views with their owner's rights, but not the tables", async () => {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE reporting_ro");
        const { rows } = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM report_sales_by_concert",
        );
        assert.equal(Number(rows[0]!.n), 3); // X in SGD and USD, Y in SGD
        await assert.rejects(client.query("SELECT 1 FROM orders LIMIT 1"), {
          code: "42501",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  },
);
