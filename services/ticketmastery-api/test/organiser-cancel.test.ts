/**
 * UC5 cancellation notices against Postgres: cancelling a concert publishes one ConcertCancelled event per confirmed
 * order (and none for checkout attempts that never became tickets). Orders are made by the real UC5 + UC4 services.
 * The SNS publisher is replaced, so nothing reaches AWS. Skipped when DB_HOST is unset; runs in a throwaway schema.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type * as PoolModule from '../src/db/pool';
import type * as CheckoutServiceModule from '../src/modules/checkout/service';
import type * as OrganiserEventsModule from '../src/modules/organiser/events';
import type * as OrganiserServiceModule from '../src/modules/organiser/service';

const schema = `tm_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const ORGANISER = 'org-cancel-test';

describe('UC5 cancellation notices (Postgres)', { skip: process.env.DB_HOST ? false : 'DB_HOST not set' }, () => {
  let db: typeof PoolModule;
  let organiser: typeof OrganiserServiceModule;
  let checkout: typeof CheckoutServiceModule;
  let events: typeof OrganiserEventsModule;

  /** A published concert with GA row A1-6 (S$100), sale open. Returns seat ids by label. */
  async function createOnSaleConcert() {
    const day = 24 * 60 * 60 * 1000;
    const concert = await organiser.createConcert(ORGANISER, {
      title: `Cancel ${randomUUID()}`,
      artist: 'Test Artist',
      venueName: 'Test Hall',
      saleStartsAt: new Date(Date.now() + day).toISOString(),
      saleEndsAt: new Date(Date.now() + 2 * day).toISOString(),
      startsAt: new Date(Date.now() + 3 * day).toISOString(),
    });
    await organiser.replaceTicketTypes(ORGANISER, concert.id, {
      ticketTypes: [{ name: 'GA', priceCents: 10_000, currency: 'SGD', quantity: 6, maxPerOrder: 4 }],
    });
    await organiser.replaceLayout(ORGANISER, concert.id, {
      sections: [{ name: 'Floor', rows: [{ label: 'A', ticketTypeName: 'GA', seats: { from: 1, to: 6 } }] }],
    });
    await organiser.publishConcert(ORGANISER, concert.id);
    await db.query(`UPDATE concerts SET sale_starts_at = now() - interval '1 minute' WHERE id = $1`, [concert.id]);
    const { rows } = await db.query<{ id: string; label: string }>(
      `SELECT s.id, r.label || s.seat_number AS label FROM seats s JOIN rows r ON r.id = s.row_id
        WHERE s.concert_id = $1`,
      [concert.id],
    );
    return { concert, seat: Object.fromEntries(rows.map((r) => [r.label, r.id])) as Record<string, string> };
  }

  async function buy(fanId: string, concertId: string, seatIds: string[]) {
    const hold = await checkout.createHold(fanId, { concertId, seatIds });
    return checkout.confirmHold(fanId, hold.holdId, { simulatePaymentFailure: false });
  }

  before(async () => {
    // Dynamic imports, like checkout.test.ts: config is validated and PGOPTIONS read when the modules load.
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    Object.assign(process.env, { AUTH_MODE: 'dev-header', LOG_LEVEL: 'silent' });
    delete process.env.ORDER_EVENTS_TOPIC_ARN;
    db = await import('../src/db/pool.js');
    await db.query(`CREATE SCHEMA ${schema}`);
    await (await import('../src/db/migrate.js')).runMigrations();
    organiser = await import('../src/modules/organiser/service.js');
    checkout = await import('../src/modules/checkout/service.js');
    events = await import('../src/modules/organiser/events.js');
  });

  after(async () => {
    await db?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db?.pool.end();
  });

  test('one ConcertCancelled per confirmed order, carrying what the email needs', async (t) => {
    const { concert, seat } = await createOnSaleConcert();
    const a = await buy('fan-a', concert.id, [seat.A1!, seat.A2!]);
    const b = await buy('fan-b', concert.id, [seat.A3!]);
    // Checkout attempts that never became tickets get no notice: a pending hold and a declined payment.
    await checkout.createHold('fan-c', { concertId: concert.id, seatIds: [seat.A4!] });
    const declined = await checkout.createHold('fan-d', { concertId: concert.id, seatIds: [seat.A5!] });
    await assert.rejects(checkout.confirmHold('fan-d', declined.holdId, { simulatePaymentFailure: true }));

    const publish = t.mock.method(events.organiserEvents, 'publishConcertCancelled', async () => ({
      failedOrderIds: [],
    }));
    const result = await organiser.cancelConcert(ORGANISER, concert.id, 'Artist unwell');

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.cancellationNotices, { orders: 2, published: 2 });
    assert.equal(publish.mock.callCount(), 1);
    const sent = publish.mock.calls[0]!.arguments[0]!;
    const common = {
      type: 'ConcertCancelled',
      version: 1,
      occurredAt: result.cancelledAt!.toISOString(),
      concert: {
        id: concert.id,
        title: concert.title,
        artist: 'Test Artist',
        venueName: 'Test Hall',
        startsAt: new Date(concert.startsAt).toISOString(),
      },
      reason: 'Artist unwell',
      currency: 'SGD',
    };
    assert.deepEqual(
      [...sent].sort((x, y) => x.fanId.localeCompare(y.fanId)),
      [
        { ...common, orderId: a.orderId, fanId: 'fan-a', totalCents: a.totalCents },
        { ...common, orderId: b.orderId, fanId: 'fan-b', totalCents: b.totalCents },
      ],
    );
  });

  test('orders SNS did not accept are counted, and a second cancel is refused without publishing again', async (t) => {
    const { concert, seat } = await createOnSaleConcert();
    const a = await buy('fan-a', concert.id, [seat.A1!]);
    await buy('fan-b', concert.id, [seat.A2!]);

    const publish = t.mock.method(events.organiserEvents, 'publishConcertCancelled', async () => ({
      failedOrderIds: [a.orderId],
    }));
    const result = await organiser.cancelConcert(ORGANISER, concert.id, 'Venue unavailable');
    assert.deepEqual(result.cancellationNotices, { orders: 2, published: 1 });

    await assert.rejects(organiser.cancelConcert(ORGANISER, concert.id, 'again'), { status: 409 });
    assert.equal(publish.mock.callCount(), 1);
  });

  test('a concert with no sales publishes nothing', async (t) => {
    const { concert } = await createOnSaleConcert();
    const publish = t.mock.method(events.organiserEvents, 'publishConcertCancelled', async () => ({
      failedOrderIds: [],
    }));
    const result = await organiser.cancelConcert(ORGANISER, concert.id, 'Low demand');

    assert.deepEqual(result.cancellationNotices, { orders: 0, published: 0 });
    assert.deepEqual(publish.mock.calls[0]?.arguments[0] ?? [], []);
  });
});
