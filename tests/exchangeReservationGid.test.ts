import { describe, expect, it } from "vitest";
import { buildReservationDraft } from "@/lib/exchangeReservation";
import { buildReturnInput } from "@/lib/returnPayload";

// Order #310741's stock hold, replayed 2026-08-13, failed with:
//
//   Invalid global id
//   'gid://shopify/ProductVariant/gid://shopify/ProductVariant/55904239845702'
//
// `new_variant_id` is stored as a full GID and the builder wrapped it in the
// prefix a second time. `draftOrderCreate` rejects the whole mutation, and
// because actions/exchangeReservation.ts is best-effort by construction the
// failure was swallowed into a console.error nobody reads. Result: 259 exchange
// lines in the table, ZERO stock holds ever placed — every exchange since the
// feature shipped has been running unprotected, which is precisely the "took
// money for a garment we may not be able to send" case its own comment warns of.

const EXPIRY = "2026-09-12T21:18:05.310Z";
const ORDER = { id: "13158935429446", orderNumber: "#310741", email: "coeneleanor@gmail.com" };

/** As stored: the replacement is a GID, the original is bare. */
const storedAsGid = {
  variant_id: "55904239812934",
  new_variant_id: "gid://shopify/ProductVariant/55904239845702",
  action: "CAMBIO",
  quantity: 1,
  confirmed: true,
  refunded: null,
};

/** Defensive: the same row if the column were ever written bare instead. */
const storedBare = { ...storedAsGid, new_variant_id: "55904239845702" };

describe("buildReservationDraft variant ids", () => {
  it("does not double-prefix a stored GID", () => {
    const draft = buildReservationDraft(ORDER, [storedAsGid], EXPIRY);
    expect(draft.lineItems).toEqual([
      {
        variantId: "gid://shopify/ProductVariant/55904239845702",
        quantity: 1,
        requiresShipping: true,
      },
    ]);
  });

  it("still handles a bare id, so the column's shape cannot matter", () => {
    const draft = buildReservationDraft(ORDER, [storedBare], EXPIRY);
    expect(draft.lineItems[0].variantId).toBe(
      "gid://shopify/ProductVariant/55904239845702"
    );
  });

  it("drops an unresolvable line instead of failing the whole hold", () => {
    // Partial hold beats no hold: one junk row must not cost every other
    // garment in the submission its reservation.
    const draft = buildReservationDraft(
      ORDER,
      [{ ...storedAsGid, new_variant_id: "not-an-id" }, storedBare],
      EXPIRY
    );
    expect(draft.lineItems).toHaveLength(1);
    expect(draft.lineItems[0].variantId).toBe(
      "gid://shopify/ProductVariant/55904239845702"
    );
  });
});

describe("buildReturnInput exchange line ids", () => {
  // Same double-prefix, currently masked because NATIVE_EXCHANGES is off.
  // Turning that flag on would have failed returnCreate the same way.
  const line = {
    variant_id: "55904239812934",
    fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/19590829408582",
    quantity: 1,
    action: "CAMBIO",
    reason: "TOO_SMALL",
    notes: "",
    new_variant_id: "gid://shopify/ProductVariant/55904239845702",
  };

  it("does not double-prefix a stored GID", () => {
    const input = buildReturnInput("13158935429446", [line], 5, {
      includeExchangeItems: true,
    });
    expect(input.exchangeLineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/55904239845702", quantity: 1 },
    ]);
  });

  it("drops an unresolvable exchange line rather than the whole mutation", () => {
    const input = buildReturnInput(
      "13158935429446",
      [{ ...line, new_variant_id: "not-an-id" }],
      5,
      { includeExchangeItems: true }
    );
    // No usable exchange line -> omit the key entirely, exactly as the existing
    // empty-list handling does: Shopify reads [] as "an exchange with nothing
    // in it".
    expect(input.exchangeLineItems).toBeUndefined();
  });
});
