/**
 * Seats one fan can buy in one order (one hold). Checkout caps a hold request at this, organisers cannot set a ticket
 * type's max_per_order above it, and migration 0005 enforces the same 1-3 range on ticket_types.max_per_order.
 * No imports, so any module can use it.
 */
export const MAX_SEATS_PER_ORDER = 3;
