/**
 * Holding the replacement garment from the moment the customer pays.
 *
 * Pure — no network, no database.
 *
 * Measured on the live store: inventory is committed only when an admin
 * validates the return, which is days after payment because the parcel has to
 * travel back first. `returnCreate` reserves nothing. So between paying for an
 * exchange and receiving it, the customer's size could sell out to somebody
 * else — with their money already taken.
 *
 * The hold is a Shopify draft order carrying `reserveInventoryUntil`. It is
 * NEVER completed. At validation it is deleted and the real exchange order is
 * created exactly as before, so an exchange's accounting shape is unchanged and
 * this is a pure stock mechanism that can be switched off without trace.
 */

import { variantGid } from "@/lib/shopifyIds";

/** Fields this module needs from a `productsorder` row. Structural, so callers
 *  pass their own rows unchanged. */
export type ExchangeLine = {
  variant_id: string;
  new_variant_id?: string | null;
  action?: string | null;
  quantity?: number | null;
  confirmed?: boolean | null;
  refunded?: boolean | null;
};

export type ReservationDraft = {
  lineItems: Array<{
    variantId: string;
    quantity: number;
    requiresShipping: boolean;
  }>;
  reserveInventoryUntil: string;
  visibleToCustomer: boolean;
  tags: string[];
  note: string;
  email?: string;
};

/** The tag every hold carries, so a stray one can be found and released even if
 *  our own pointer to it is lost. */
export const RESERVATION_TAG = "exchange-reservation";

/** Default hold window. A return has to be posted, travel, and be booked in
 *  before the exchange is validated; 30 days covers that with room, and the
 *  reservation lapses on its own if the parcel never arrives, so a forgotten
 *  hold cannot freeze stock indefinitely. Override with
 *  EXCHANGE_RESERVATION_DAYS. */
export const DEFAULT_RESERVATION_DAYS = 30;

/**
 * The lines worth holding stock for: a confirmed exchange, not yet settled,
 * with a replacement variant actually recorded.
 *
 * `confirmed` is the paid/committed flag — an abandoned checkout must not
 * freeze stock. `refunded` means the replacement has already shipped.
 */
export function reservableLines(lines: ExchangeLine[]): ExchangeLine[] {
  return (lines ?? []).filter(
    (line) =>
      line.action === "CAMBIO" &&
      !!line.new_variant_id &&
      line.confirmed === true &&
      !line.refunded
  );
}

/**
 * When the hold should lapse.
 *
 * Clamped to at least one day: a zero or negative window would create a
 * reservation that expires immediately, reserving nothing while looking in
 * every log and every admin screen as though it had.
 */
export function reservationExpiry(now: Date, days: number): string {
  const safeDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1;
  return new Date(now.getTime() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Build the draft order that holds the stock.
 *
 * One draft for the whole submission, mirroring the exchange order it will
 * eventually be replaced by — one parcel, one hold.
 */
export function buildReservationDraft(
  order: { id: string; orderNumber: string; email?: string },
  lines: ExchangeLine[],
  expiryIso: string
): ReservationDraft {
  const held = reservableLines(lines);

  return {
    // `new_variant_id` is stored as a full GID; prefixing it again produced an
    // id Shopify refused, which failed the draft and left the stock unheld —
    // silently, because the caller is best-effort. A line whose id cannot be
    // resolved is dropped rather than sent malformed: a partial hold beats one
    // junk row costing every other garment its reservation.
    lineItems: held
      .map((line) => ({
        variantId: variantGid(line.new_variant_id),
        quantity: Math.max(1, Number(line.quantity) || 1),
        requiresShipping: true,
      }))
      .filter(
        (item): item is { variantId: string; quantity: number; requiresShipping: boolean } =>
          item.variantId !== null
      ),
    reserveInventoryUntil: expiryIso,
    // A stock hold, not an offer. Shopify can email a draft order as an
    // invoice; the customer must never receive one for this.
    visibleToCustomer: false,
    tags: [RESERVATION_TAG, `Order ${order.orderNumber}`],
    note: `Stock hold for the exchange on ${order.orderNumber}. Not an order — deleted when the exchange is validated.`,
  };
}
