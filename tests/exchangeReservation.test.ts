import { describe, expect, it } from "vitest";
import {
  buildReservationDraft,
  reservableLines,
  reservationExpiry,
} from "@/lib/exchangeReservation";

// Nothing reserved the replacement garment between the customer paying for
// their exchange and an admin validating it days later, once the parcel had
// travelled back. Measured on the live store: inventory is committed only at
// validation — `returnCreate` moves nothing, and so does creating the return.
// In between, the size the customer paid for can sell out.
//
// The hold is a draft order with `reserveInventoryUntil`. It is NEVER
// completed: at validation it is deleted and the real exchange order is created
// exactly as before, so the accounting shape of an exchange does not change.

const ORDER = {
  id: "13161229386054",
  orderNumber: "#310756",
  email: "customer@example.com",
  shippingName: "Ada Lovelace",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: "",
  shippingCity: "Madrid",
  shippingZip: "28001",
  shippingProvince: "Madrid",
  shippingPhone: "+34600000000",
};

const LINES = [
  { variant_id: "111", new_variant_id: "aaa", action: "CAMBIO", quantity: 1, confirmed: true, refunded: false },
  { variant_id: "222", new_variant_id: "bbb", action: "CAMBIO", quantity: 1, confirmed: true, refunded: false },
];

describe("reservableLines", () => {
  it("takes the confirmed, unsettled exchange lines", () => {
    expect(reservableLines(LINES).map((l) => l.new_variant_id)).toEqual(["aaa", "bbb"]);
  });

  it("ignores plain returns — there is nothing to send back", () => {
    const lines = [...LINES, { variant_id: "333", new_variant_id: null, action: "DEVOLUCIÓN", quantity: 1, confirmed: true, refunded: false }];
    expect(reservableLines(lines)).toHaveLength(2);
  });

  it("ignores a CAMBIO whose replacement variant was never recorded", () => {
    // Reserving `null` would fail the whole draft and cost the other line its
    // hold too.
    const lines = [LINES[0], { ...LINES[1], new_variant_id: null }];
    expect(reservableLines(lines)).toHaveLength(1);
  });

  it("ignores lines that are already settled", () => {
    // The garment has shipped; holding stock for it would double-count.
    expect(reservableLines(LINES.map((l) => ({ ...l, refunded: true })))).toHaveLength(0);
  });

  it("ignores unconfirmed lines", () => {
    // The customer has not paid yet — an abandoned checkout must not freeze
    // stock.
    expect(reservableLines(LINES.map((l) => ({ ...l, confirmed: false })))).toHaveLength(0);
  });
});

describe("reservationExpiry", () => {
  it("holds the stock for the configured number of days", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    expect(reservationExpiry(now, 30)).toBe("2026-08-29T12:00:00.000Z");
  });

  it("never returns a hold in the past", () => {
    // A zero or negative window would reserve nothing while looking like it had.
    const now = new Date("2026-07-30T12:00:00.000Z");
    expect(new Date(reservationExpiry(now, 0)).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(reservationExpiry(now, -5)).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("buildReservationDraft", () => {
  const draft = buildReservationDraft(ORDER, LINES, "2026-08-29T12:00:00.000Z");

  it("reserves every replacement garment in ONE draft", () => {
    expect(draft.lineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/aaa", quantity: 1, requiresShipping: true },
      { variantId: "gid://shopify/ProductVariant/bbb", quantity: 1, requiresShipping: true },
    ]);
  });

  it("sets the reservation deadline", () => {
    expect(draft.reserveInventoryUntil).toBe("2026-08-29T12:00:00.000Z");
  });

  it("stays invisible to the customer", () => {
    // It is a stock hold, not an offer. An invoice for it must never reach them.
    expect(draft.visibleToCustomer).toBe(false);
  });

  it("is tagged so a stray hold can be found and released", () => {
    expect(draft.tags).toContain("exchange-reservation");
    expect(draft.tags).toContain("Order #310756");
  });

  it("names the order it is holding stock for", () => {
    expect(draft.note).toContain("#310756");
  });
});
