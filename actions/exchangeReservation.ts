// Server-only: talks to the Shopify Admin API and the database. Imported by
// server actions and route handlers.
//
// Places and releases the stock hold on an exchange's replacement garment.
// The decision logic is pure and lives in lib/exchangeReservation.ts.
//
// EVERY function here is best-effort and never throws. The customer has
// already paid by the time these run, and the collection or label may already
// be booked. A failed stock hold is a merchandising problem to chase, not a
// reason to fail — or worse, revert — a return that exists in the real world.
// That is the lesson of order #310972.

import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_RESERVATION_DAYS,
  buildReservationDraft,
  reservableLines,
  reservationExpiry,
} from "@/lib/exchangeReservation";

const shopifyUrl = () =>
  `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

function headers() {
  const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
  if (!token) throw new Error("Missing Shopify access token");
  return { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
}

async function shopify(query: string, variables: Record<string, unknown>) {
  const response = await fetch(shopifyUrl(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

function reservationDays(): number {
  const configured = Number(process.env.EXCHANGE_RESERVATION_DAYS);
  return Number.isFinite(configured) && configured >= 1
    ? configured
    : DEFAULT_RESERVATION_DAYS;
}

const CREATE = `
  mutation ReserveExchangeStock($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name reserveInventoryUntil }
      userErrors { field message }
    }
  }
`;

const DELETE = `
  mutation ReleaseExchangeStock($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

/**
 * Hold the replacement garments for an order's exchange lines.
 *
 * Called once the return is confirmed — which is the moment the customer has
 * paid. Idempotent: an order that already holds a reservation is left alone,
 * so a Stripe webhook retry cannot freeze the stock twice.
 */
export async function reserveExchangeStock(orderId: string): Promise<void> {
  try {
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: { products: true },
    });
    if (!order) return;

    if (order.exchangeReservationId) {
      console.warn(
        `Exchange reservation already held for order ${orderId} (${order.exchangeReservationId}) — not creating a second hold.`
      );
      return;
    }

    const lines = reservableLines((order as any).products ?? []);
    if (lines.length === 0) return;

    const input = buildReservationDraft(
      { id: order.id, orderNumber: order.orderNumber, email: order.email },
      lines,
      reservationExpiry(new Date(), reservationDays())
    );

    const data = await shopify(CREATE, { input });
    const errors =
      data.errors ?? data.data?.draftOrderCreate?.userErrors ?? [];
    const draft = data.data?.draftOrderCreate?.draftOrder;

    if (errors.length > 0 || !draft) {
      // The most likely cause is that the size is ALREADY out of stock — which
      // means we have taken money for a garment we may not be able to send.
      // Loud, because it needs a human.
      console.error(
        `EXCHANGE STOCK NOT RESERVED for order ${order.orderNumber} (${orderId}). The replacement may sell out before the return arrives. Errors:`,
        JSON.stringify(errors)
      );
      return;
    }

    await db
      .update(orders)
      .set({ exchangeReservationId: draft.id })
      .where(eq(orders.id, orderId));

    console.log(
      `[exchange] reserved stock for ${order.orderNumber}: ${draft.name} (${draft.id}) until ${draft.reserveInventoryUntil}`
    );
  } catch (error: any) {
    console.error(
      `Failed to reserve exchange stock for order ${orderId} — the return is unaffected:`,
      error?.message || error
    );
  }
}

/**
 * Release the hold.
 *
 * Called at validation, immediately BEFORE the real exchange order is created,
 * and on the revert path. The ordering matters: the hold and the real order
 * would otherwise both claim the same unit, and with
 * DECREMENT_OBEYING_POLICY the last garment in stock would refuse to sell to
 * the very customer it is being held for.
 *
 * Returns true when there is no longer a hold — including when there never was
 * one — so the caller can proceed.
 */
export async function releaseExchangeReservation(
  orderId: string
): Promise<boolean> {
  try {
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    });
    const reservationId = order?.exchangeReservationId;
    if (!reservationId) return true;

    const data = await shopify(DELETE, { input: { id: reservationId } });
    const errors = data.errors ?? data.data?.draftOrderDelete?.userErrors ?? [];

    if (errors.length > 0) {
      console.error(
        `Failed to release exchange reservation ${reservationId} for order ${orderId}:`,
        JSON.stringify(errors)
      );
      // Do NOT clear the column: it is the only pointer to a hold that is still
      // holding stock, and losing it strands the units until the reservation
      // lapses on its own.
      return false;
    }

    await db
      .update(orders)
      .set({ exchangeReservationId: null })
      .where(eq(orders.id, orderId));

    return true;
  } catch (error: any) {
    console.error(
      `Error releasing exchange reservation for order ${orderId}:`,
      error?.message || error
    );
    return false;
  }
}
