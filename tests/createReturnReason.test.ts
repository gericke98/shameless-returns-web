import { beforeEach, describe, expect, it, vi } from "vitest";

// `returnCreate` hardcoded `returnReason: COLOR` on every line item, so Shopify
// recorded "Color" for every return the portal ever created. These tests pin
// that the customer's actual reason is sent, and that their free-text note
// cannot break out of the GraphQL document it is interpolated into.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("@/db/drizzle", () => ({ default: {} }));

const sent: string[] = [];

beforeEach(() => {
  sent.length = 0;
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "shpat_test";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://example.myshopify.com";

  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).query);
    return {
      json: async () => ({
        data: {
          returnCreate: {
            userErrors: [],
            return: {
              id: "gid://shopify/Return/1",
              returnLineItems: { nodes: [{ id: "gid://shopify/ReturnLineItem/1" }] },
              order: { transactions: [] },
            },
          },
        },
      }),
    };
  });
});

async function callCreateReturn(product: Record<string, unknown>) {
  const { createReturn } = await import("@/db/queries");
  await createReturn(
    "13194624794950",
    "gid://shopify/FulfillmentLineItem/1",
    product,
    undefined,
    5
  );
  return sent[0];
}

describe("createReturn return reason", () => {
  it("sends the customer's reason instead of the hardcoded COLOR", async () => {
    const mutation = await callCreateReturn({ reason: "TOO_SMALL", notes: "" });

    expect(mutation).toContain("returnReason: SIZE_TOO_SMALL");
    expect(mutation).not.toContain("returnReason: COLOR");
  });

  it("maps a damaged item to DEFECTIVE", async () => {
    const mutation = await callCreateReturn({ reason: "DAMAGED", notes: "" });
    expect(mutation).toContain("returnReason: DEFECTIVE");
  });

  it("degrades an unknown reason to OTHER, never COLOR", async () => {
    const mutation = await callCreateReturn({ reason: null, notes: "" });
    expect(mutation).toContain("returnReason: OTHER");
    expect(mutation).not.toContain("COLOR");
  });

  it("carries the customer's note through", async () => {
    const mutation = await callCreateReturn({
      reason: "OTHER",
      notes: "Arrived after my holiday",
    });
    expect(mutation).toContain('returnReasonNote: "Arrived after my holiday"');
  });

  it("omits the note field entirely when there is no note", async () => {
    const mutation = await callCreateReturn({ reason: "TOO_BIG", notes: "" });
    expect(mutation).not.toContain("returnReasonNote");
  });

  it("escapes a note that would otherwise break the mutation", async () => {
    // Customer-supplied free text goes into a GraphQL document by string
    // interpolation. A bare quote would end the string and corrupt the query.
    const mutation = await callCreateReturn({
      reason: "OTHER",
      notes: 'it said "large" \\ but\nit was not',
    });

    expect(mutation).toContain(
      'returnReasonNote: "it said \\"large\\" \\\\ but\\nit was not"'
    );
    // The raw newline must not survive into the document.
    const noteLine = mutation
      .split("\n")
      .find((l) => l.includes("returnReasonNote"))!;
    expect(noteLine).toContain("it was not");
  });
});
