import { beforeEach, describe, expect, it, vi } from "vitest";

// `orderUpdate` takes `note` as a whole string, so writing one is a
// read-modify-write on a field the CUSTOMER can also write — a checkout note
// lands in exactly this field. Replacing it destroys something only they could
// have written, and nothing in Shopify would flag it.
//
// (`OrderInput.tags` replaces wholesale for the same reason. Amphora owns the
// tags on these orders — `amphora_*`, `APH` — so a tag has to go through
// `tagsAdd`, never through this mutation.)

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

const GIFT_CARD = "gid://shopify/GiftCard/1310634049862";

const existingNote = { value: null as string | null };
const sent: any[] = [];

global.fetch = (async (_url: string, init: any) => {
  const body = JSON.parse(String(init.body));
  sent.push(body);
  if (body.query.includes("query orderNote")) {
    return { json: async () => ({ data: { order: { note: existingNote.value } } }) };
  }
  return {
    json: async () => ({
      data: { orderUpdate: { order: { id: body.variables.input.id }, userErrors: [] } },
    }),
  };
}) as any;

const writtenNote = () =>
  sent.find((b) => b.query.includes("mutation orderUpdate"))?.variables.input.note;

beforeEach(() => {
  sent.length = 0;
  existingNote.value = null;
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.example.com";
});

describe("noting store credit on the order", () => {
  it("writes the gift card value and id where a human will see them", async () => {
    const { noteStoreCreditOnOrder } = await import("@/db/queries");

    await noteStoreCreditOnOrder("13253700485446", 37.41, GIFT_CARD);

    expect(writtenNote()).toContain("37.41");
    expect(writtenNote()).toContain(GIFT_CARD);
  });

  it("keeps the customer's own checkout note", async () => {
    // The one that matters. A plain overwrite passes every other assertion
    // here while silently deleting what the customer wrote at checkout.
    existingNote.value = "Please leave with the neighbour at number 4";

    const { noteStoreCreditOnOrder } = await import("@/db/queries");
    await noteStoreCreditOnOrder("13253700485446", 37.41, GIFT_CARD);

    expect(writtenNote()).toContain("Please leave with the neighbour at number 4");
    expect(writtenNote()).toContain(GIFT_CARD);
  });

  it("does not write the same sentence twice when settlement is re-run", async () => {
    existingNote.value = `Return paid in store credit: gift card 37.41 EUR (${GIFT_CARD}). No money was refunded.`;

    const { noteStoreCreditOnOrder } = await import("@/db/queries");
    const result = await noteStoreCreditOnOrder("13253700485446", 37.41, GIFT_CARD);

    expect(result).toMatchObject({ success: true, alreadyNoted: true });
    expect(sent.some((b) => b.query.includes("mutation orderUpdate"))).toBe(false);
  });

  it("addresses the order by gid, not by the bare database id", async () => {
    const { noteStoreCreditOnOrder } = await import("@/db/queries");

    await noteStoreCreditOnOrder("13253700485446", 37.41, GIFT_CARD);

    const update = sent.find((b) => b.query.includes("mutation orderUpdate"));
    expect(update.variables.input.id).toBe(
      "gid://shopify/Order/13253700485446"
    );
  });
});
