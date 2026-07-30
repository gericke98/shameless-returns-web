import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildReturnInput } from "@/lib/returnPayload";

// `returnCreate` hardcoded `returnReason: COLOR` on every line item, so Shopify
// recorded "Color" for every return the portal ever created. These tests pin
// that the customer's actual reason is sent, and that their free-text note is
// carried as DATA.
//
// The note used to be interpolated into the GraphQL document and quoted with
// JSON.stringify. That was correct, but it put customer-controlled text one
// edit away from the document that creates returns and moves money. It now
// travels as a GraphQL variable, where quoting is not our problem at all —
// which is why these tests assert on the variables rather than on a string.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/drizzle", () => ({ default: {} }));

const sent: any[] = [];

const line = (over: Record<string, unknown> = {}) => ({
  variant_id: "111",
  fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1",
  quantity: 1,
  action: "DEVOLUCIÓN",
  reason: "TOO_SMALL",
  notes: "",
  new_variant_id: null,
  ...over,
});

beforeEach(() => {
  sent.length = 0;
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "shpat_test";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://example.myshopify.com";

  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return {
      json: async () => ({
        data: {
          returnCreate: {
            userErrors: [],
            return: {
              id: "gid://shopify/Return/1",
              name: "#310972-R1",
              returnLineItems: {
                nodes: [
                  {
                    id: "gid://shopify/ReturnLineItem/1",
                    fulfillmentLineItem: {
                      id: "gid://shopify/FulfillmentLineItem/1",
                    },
                  },
                ],
              },
              exchangeLineItems: { nodes: [] },
              order: { transactions: [] },
            },
          },
        },
      }),
    };
  });
});

function reasonFor(over: Record<string, unknown>) {
  return buildReturnInput("13194624794950", [line(over)], 5, {
    includeExchangeItems: false,
  }).returnLineItems[0];
}

describe("createReturn return reason", () => {
  it("sends the customer's reason instead of the hardcoded COLOR", () => {
    expect(reasonFor({ reason: "TOO_SMALL" }).returnReason).toBe("SIZE_TOO_SMALL");
  });

  it("maps a damaged item to DEFECTIVE", () => {
    expect(reasonFor({ reason: "DAMAGED" }).returnReason).toBe("DEFECTIVE");
  });

  it("degrades an unknown reason to OTHER, never COLOR", () => {
    expect(reasonFor({ reason: null }).returnReason).toBe("OTHER");
  });

  it("carries the customer's note through", () => {
    expect(
      reasonFor({ reason: "OTHER", notes: "Arrived after my holiday" })
        .returnReasonNote
    ).toBe("Arrived after my holiday");
  });

  it("omits the note field entirely when there is no note", () => {
    expect(reasonFor({ reason: "TOO_BIG", notes: "" }).returnReasonNote).toBeUndefined();
  });

  it("carries a note containing quotes and newlines verbatim", () => {
    // As a variable this is inert: there is no document for it to break out of,
    // and no escaping for us to get wrong.
    const raw = 'it said "large" \\ but\nit was not';
    expect(reasonFor({ reason: "OTHER", notes: raw }).returnReasonNote).toBe(raw);
  });
});

describe("createReturn transport", () => {
  it("sends the payload as GraphQL variables, not inside the document", async () => {
    const { createReturn } = await import("@/db/queries");
    const input = buildReturnInput("13194624794950", [line({ notes: 'a "quote"' })], 5, {
      includeExchangeItems: false,
    });

    await createReturn(input);

    const body = sent[0];
    expect(body.variables.input).toEqual(input);
    // The customer's words must not appear in the query document at all.
    expect(body.query).not.toContain("quote");
  });

  it("returns the return line items keyed back to their fulfillment line item", async () => {
    const { createReturn } = await import("@/db/queries");
    const result = await createReturn(
      buildReturnInput("13194624794950", [line()], 5, { includeExchangeItems: false })
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.returnLineItems[0].fulfillmentLineItem.id).toBe(
      "gid://shopify/FulfillmentLineItem/1"
    );
  });
});
