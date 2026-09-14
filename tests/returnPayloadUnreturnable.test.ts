import { describe, expect, it } from "vitest";
import { buildReturnInput } from "@/lib/returnPayload";

// Order #310828 (Urtė Petrauskaitė). Her order had two pairs of jeans, both
// carrying `action = DEVOLUCIÓN` from an earlier submission. On 2026-09-14 at
// 05:07 UTC one of them — FLARE GRAPHITE — was given a 0.00 EUR refund in the
// Shopify admin, which drops that line's `refundableQuantity` to 0.
//
// Her saved row still said DEVOLUCIÓN, so every retry put the dead line back in
// the payload, and Shopify rejected the WHOLE mutation:
//
//   returnInput.returnLineItems.0.quantity
//   "Return line item has an invalid quantity."
//
// So the returnable pair could not be returned either. She tried three times
// and wrote in. The rule this pins is the one the module already applies to a
// line with no fulfillment line item: drop what Shopify cannot accept, because
// sending it fails the mutation for every OTHER line too.

const FLI_GOOD = "gid://shopify/FulfillmentLineItem/19625098150214";
const FLI_DEAD = "gid://shopify/FulfillmentLineItem/19625098182982";

const icon = {
  variant_id: "55904239747398",
  fulfillmentLineItemId: FLI_GOOD,
  quantity: 1,
  action: "DEVOLUCIÓN",
  reason: "DISLIKE",
  notes: "",
  new_variant_id: null,
  refundableQuantity: 1,
};

const flare = {
  variant_id: "56000013893958",
  fulfillmentLineItemId: FLI_DEAD,
  quantity: 1,
  action: "DEVOLUCIÓN",
  reason: "TOO_SMALL",
  notes: "",
  new_variant_id: null,
  refundableQuantity: 0,
};

function build(lines: any[]) {
  return buildReturnInput("13172075168070", lines, 5, {
    includeExchangeItems: false,
  });
}

describe("buildReturnInput drops lines Shopify can no longer return", () => {
  it("keeps the returnable pair when a sibling is already refunded", () => {
    const input = build([icon, flare]);

    expect(input.returnLineItems).toHaveLength(1);
    expect(input.returnLineItems[0].fulfillmentLineItemId).toBe(FLI_GOOD);
  });

  it("drops a line whose refundable quantity is zero", () => {
    const input = build([flare]);

    expect(input.returnLineItems).toHaveLength(0);
  });

  // Asking for more than Shopify will take fails the whole mutation just as a
  // zero does, so the same rule covers it.
  it("drops a line asking for more than remains refundable", () => {
    const input = build([{ ...icon, quantity: 2, refundableQuantity: 1 }]);

    expect(input.returnLineItems).toHaveLength(0);
  });

  it("keeps a line asking for exactly what remains", () => {
    const input = build([{ ...icon, quantity: 2, refundableQuantity: 2 }]);

    expect(input.returnLineItems).toHaveLength(1);
    expect(input.returnLineItems[0].quantity).toBe(2);
  });

  // Every row that predates this field, and every caller that does not resolve
  // it, must behave exactly as before — unknown is not a reason to refuse.
  it("keeps a line whose refundable quantity is unknown", () => {
    const { refundableQuantity, ...withoutField } = icon;

    expect(build([withoutField]).returnLineItems).toHaveLength(1);
    expect(build([{ ...icon, refundableQuantity: null }]).returnLineItems).toHaveLength(1);
    expect(
      build([{ ...icon, refundableQuantity: undefined }]).returnLineItems
    ).toHaveLength(1);
  });
});
