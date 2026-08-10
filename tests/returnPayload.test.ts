import { describe, expect, it } from "vitest";
import { buildReturnInput, matchReturnLineItems } from "@/lib/returnPayload";

// `updateFinalOrder` mapped over the products and called `createReturn` once
// PER LINE. Order #310756 in production is the result:
//
//   #310756-R1  returnShippingFee 5.00  exchangeLineItems []
//   #310756-R2  returnShippingFee 5.00  exchangeLineItems []
//
// One parcel, two Shopify returns, and 10 EUR of return shipping fee charged
// for a 5 EUR parcel — because the fee is computed for the whole parcel and
// then handed to every line's own createReturn call.
//
// It is also why the dashboard mints one exchange ORDER per line: each return
// is validated separately.

const FLI_A = "gid://shopify/FulfillmentLineItem/1";
const FLI_B = "gid://shopify/FulfillmentLineItem/2";

const returnLine = {
  variant_id: "111",
  fulfillmentLineItemId: FLI_A,
  quantity: 1,
  action: "DEVOLUCIÓN",
  reason: "TOO_SMALL",
  notes: "",
  new_variant_id: null,
};

const exchangeLine = {
  variant_id: "222",
  fulfillmentLineItemId: FLI_B,
  quantity: 1,
  action: "CAMBIO",
  reason: "TOO_BIG",
  notes: 'He pedido la "M" y me queda grande',
  new_variant_id: "54793363751238",
};

describe("buildReturnInput", () => {
  it("puts every line in ONE return", () => {
    const input = buildReturnInput("12345", [returnLine, exchangeLine], 5, {
      includeExchangeItems: false,
    });

    expect(input.orderId).toBe("gid://shopify/Order/12345");
    expect(input.returnLineItems).toHaveLength(2);
    expect(input.returnLineItems.map((i) => i.fulfillmentLineItemId)).toEqual([
      FLI_A,
      FLI_B,
    ]);
  });

  it("charges the return shipping fee exactly once", () => {
    // The whole parcel is priced once. Charging it per line billed a 3-item
    // return three times over.
    const input = buildReturnInput("12345", [returnLine, exchangeLine], 5, {
      includeExchangeItems: false,
    });
    expect(input.returnShippingFee).toEqual({
      amount: { amount: "5.00", currencyCode: "EUR" },
    });
  });

  it("carries each line's own reason, not one reason for all of them", () => {
    const input = buildReturnInput("12345", [returnLine, exchangeLine], 5, {
      includeExchangeItems: false,
    });
    expect(input.returnLineItems[0].returnReason).toBe("SIZE_TOO_SMALL");
    expect(input.returnLineItems[1].returnReason).toBe("SIZE_TOO_LARGE");
  });

  it("passes the customer's note through without breaking the payload", () => {
    // Sent as GraphQL variables, so an embedded quote is data, not syntax.
    const input = buildReturnInput("12345", [exchangeLine], 5, {
      includeExchangeItems: false,
    });
    expect(input.returnLineItems[0].returnReasonNote).toBe(
      'He pedido la "M" y me queda grande'
    );
  });

  // Live failure, order #310185 (Zinsi van der Sangen), 2026-08-09 01:51:58Z:
  //
  //   Return line items return reason note The note is required when the
  //   return reason is "Other"
  //
  // `returnCreate` rejects the WHOLE mutation, so one line with an OTHER reason
  // and an empty note loses the entire return — the customer submits, pays, and
  // gets nothing. Live on both the domestic and international paths since the
  // per-line reasons shipped on 31 July.
  it("always sends a note when the reason degrades to OTHER", () => {
    const late = { ...returnLine, reason: "LATE", notes: "" };
    const input = buildReturnInput("12345", [late], 5, {
      includeExchangeItems: false,
    });

    expect(input.returnLineItems[0].returnReason).toBe("OTHER");
    expect(input.returnLineItems[0].returnReasonNote).toBeTruthy();
  });

  it("sends a note for an OTHER line even with no reason at all", () => {
    const unstated = { ...returnLine, reason: null, notes: "   " };
    const input = buildReturnInput("12345", [unstated], 5, {
      includeExchangeItems: false,
    });

    expect(input.returnLineItems[0].returnReason).toBe("OTHER");
    expect(input.returnLineItems[0].returnReasonNote).toBeTruthy();
  });

  it("keeps free-text the customer's own words rather than inventing a note", () => {
    // Legacy rows store the Spanish label itself, which is unmapped — so it
    // degrades to OTHER, and that stored text is the best note available.
    const legacy = { ...returnLine, reason: "Llegó tarde", notes: "" };
    const input = buildReturnInput("12345", [legacy], 5, {
      includeExchangeItems: false,
    });

    expect(input.returnLineItems[0].returnReasonNote).toContain("Llegó tarde");
  });

  it("never overwrites a note the customer actually wrote", () => {
    const late = { ...returnLine, reason: "LATE", notes: "Llegó 3 semanas tarde" };
    const input = buildReturnInput("12345", [late], 5, {
      includeExchangeItems: false,
    });

    expect(input.returnLineItems[0].returnReasonNote).toBe(
      "Llegó 3 semanas tarde"
    );
  });

  it("leaves a mapped reason's note absent when there is nothing to say", () => {
    // Only OTHER carries Shopify's requirement. SIZE_TOO_SMALL must not gain a
    // manufactured note just because this fix exists.
    const input = buildReturnInput("12345", [returnLine], 5, {
      includeExchangeItems: false,
    });

    expect(input.returnLineItems[0].returnReason).toBe("SIZE_TOO_SMALL");
    expect(input.returnLineItems[0].returnReasonNote).toBeUndefined();
  });

  it("omits exchangeLineItems entirely when the native flow is off", () => {
    const input = buildReturnInput("12345", [returnLine, exchangeLine], 5, {
      includeExchangeItems: false,
    });
    expect(input.exchangeLineItems).toBeUndefined();
  });

  it("declares an exchange line item per CAMBIO line when the flow is on", () => {
    const input = buildReturnInput("12345", [returnLine, exchangeLine], 5, {
      includeExchangeItems: true,
    });
    expect(input.exchangeLineItems).toEqual([
      { variantId: "gid://shopify/ProductVariant/54793363751238", quantity: 1 },
    ]);
  });

  it("does not declare an exchange for a line with no replacement variant", () => {
    // A CAMBIO whose new_variant_id never got written would otherwise send
    // variantId: null and fail the whole mutation for the other lines too.
    const input = buildReturnInput(
      "12345",
      [{ ...exchangeLine, new_variant_id: null }],
      5,
      { includeExchangeItems: true }
    );
    expect(input.exchangeLineItems).toBeUndefined();
  });

  it("skips lines with no fulfillment line item rather than sending null", () => {
    const input = buildReturnInput(
      "12345",
      [returnLine, { ...exchangeLine, fulfillmentLineItemId: null }],
      5,
      { includeExchangeItems: false }
    );
    expect(input.returnLineItems).toHaveLength(1);
  });
});

describe("matchReturnLineItems", () => {
  it("matches by fulfillment line item, not by array position", () => {
    // Shopify does not promise to echo the input order back, and silently
    // pairing by index would file one customer's refund against another's line.
    const nodes = [
      { id: "gid://shopify/ReturnLineItem/B", fulfillmentLineItem: { id: FLI_B } },
      { id: "gid://shopify/ReturnLineItem/A", fulfillmentLineItem: { id: FLI_A } },
    ];

    const matched = matchReturnLineItems(nodes, [returnLine, exchangeLine]);

    expect(matched[returnLine.variant_id]).toBe("gid://shopify/ReturnLineItem/A");
    expect(matched[exchangeLine.variant_id]).toBe("gid://shopify/ReturnLineItem/B");
  });

  it("leaves a line unmatched rather than guessing", () => {
    const nodes = [
      { id: "gid://shopify/ReturnLineItem/A", fulfillmentLineItem: { id: FLI_A } },
    ];
    const matched = matchReturnLineItems(nodes, [returnLine, exchangeLine]);
    expect(matched[returnLine.variant_id]).toBe("gid://shopify/ReturnLineItem/A");
    expect(matched[exchangeLine.variant_id]).toBeUndefined();
  });

  it("survives a response with no fulfillmentLineItem on a node", () => {
    const nodes = [{ id: "gid://shopify/ReturnLineItem/A" }];
    expect(() => matchReturnLineItems(nodes, [returnLine])).not.toThrow();
  });
});
