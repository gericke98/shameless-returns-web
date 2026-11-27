import { beforeEach, describe, expect, it, vi } from "vitest";
import { assess, covers, need } from "@/lib/stockCoverage";

// FX §#2: the one Amphora stock reader, and the pure sums over it.

const world = vi.hoisted(() => ({
  skus: {} as Record<string, string>,
  skusThrow: false,
  rows: [] as any[],
  body: undefined as any,
  error: null as any,
  calls: [] as Array<{ url: string; config: any }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/db/queries", () => ({
  getVariantSkusByIds: async () => {
    if (world.skusThrow) throw new Error("GraphQL query failed");
    return world.skus;
  },
}));
vi.mock("axios", () => ({
  default: {
    get: async (url: string, config: any) => {
      world.calls.push({ url, config });
      if (world.error) throw world.error;
      return { data: world.body ?? { inventory_levels: world.rows } };
    },
  },
}));

const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";
const row = (sku: string, available: unknown, over: Record<string, unknown> = {}) => ({
  product_id: `xShameless${sku}`,
  sku,
  product_type: "ITEM",
  location_id: "10",
  available_quantity: available,
  reserved_quantity: 9,
  pending_quantity: 9,
  committed_quantity: 9,
  updated_at: "2026-11-26T10:00:00",
  ...over,
});

const reader = async () => (await import("@/lib/server/amphoraStock")).readAvailable;

beforeEach(() => {
  process.env.AMPHORA_API_KEY = "key";
  process.env.AMPHORA_TENANT_ID = "Shameless";
  process.env.AMPHORA_COMPANY_API_URL = "https://amphora.invalid/api";
  world.skus = { "1": "SKU-1", "2": "SKU-2" };
  world.skusThrow = false;
  world.rows = [row("SKU-1", 3), row("SKU-2", 0)];
  world.body = undefined;
  world.error = null;
  world.calls = [];
});

describe("readAvailable", () => {
  it("asks the inventory endpoint for the Shopify warehouse, with the tenant after /inventory/", async () => {
    const read = await (await reader())([V1]);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0].url).toBe("https://amphora.invalid/api/inventory/Shameless");
    expect(world.calls[0].config.params.warehouses).toBe("10");
    expect(world.calls[0].config.headers["x-api-key"]).toBe("key");
    expect(read).toEqual({
      ok: true,
      bySku: new Map([["SKU-1", { productId: "xShamelessSKU-1", locationId: "10", available: 3 }]]),
      skuOf: new Map([[V1, "SKU-1"]]),
    });
  });

  it("is unreadable, reaching nobody, when this environment has no Amphora keys (F2a)", async () => {
    delete process.env.AMPHORA_API_KEY;
    const read = await (await reader())([V1]);
    expect(read).toEqual({ ok: false, reason: "amphora-not-configured" });
    expect(world.calls).toHaveLength(0);
  });

  it("counts available_quantity only — never reserved, pending or committed", async () => {
    const read = await (await reader())([V2]);
    expect(read.ok && read.bySku.get("SKU-2")?.available).toBe(0);
  });

  it("accepts a bare variant id and the gid alike", async () => {
    const read = await (await reader())(["1"]);
    expect(read.ok && read.skuOf.get(V1)).toBe("SKU-1");
  });

  it("ignores rows at any other warehouse", async () => {
    world.rows = [row("SKU-1", 5, { location_id: "11" }), row("SKU-1", 2)];
    const read = await (await reader())([V1]);
    expect(read.ok && read.bySku.get("SKU-1")?.available).toBe(2);
  });

  // Each unreadable case is a reason, never 0 and never "enough".
  it.each([
    ["Amphora answers non-2xx", () => (world.error = { response: { status: 503 } }), "amphora-http:503"],
    ["no answer at all", () => (world.error = new Error("ECONNRESET")), "amphora-transport:ECONNRESET"],
    ["a body without inventory_levels", () => (world.body = { nope: [] }), "amphora-body"],
    ["the SKU read fails", () => (world.skusThrow = true), "shopify-skus:GraphQL query failed"],
    ["the variant has no SKU", () => (world.skus = {}), `no-sku:${V1}`],
    ["no row at the warehouse", () => (world.rows = [row("SKU-1", 4, { location_id: "11" })]), "not-at-amphora:SKU-1"],
    ["two rows for one SKU", () => (world.rows = [row("SKU-1", 1), row("SKU-1", 1, { product_id: "other" })]), "ambiguous:SKU-1"],
    ["not an ITEM", () => (world.rows = [row("SKU-1", 4, { product_type: "VIRTUAL" })]), "not-item:SKU-1"],
    ["a non-integer count", () => (world.rows = [row("SKU-1", "4")]), "bad-count:SKU-1"],
    ["a negative count", () => (world.rows = [row("SKU-1", -1)]), "bad-count:SKU-1"],
  ])("%s → unreadable", async (_name, arrange, reason) => {
    arrange();
    expect(await (await reader())([V1])).toEqual({ ok: false, reason });
  });

  it("a malformed variant id is refused before any read", async () => {
    expect(await (await reader())(["gid://shopify/Product/1"])).toEqual({
      ok: false,
      reason: "bad-variant:gid://shopify/Product/1",
    });
    expect(world.calls).toHaveLength(0);
  });

  it("demand variants must map to a SKU, but are not checked at Amphora", async () => {
    world.rows = [row("SKU-1", 3)]; // SKU-2 is not at the warehouse at all
    const read = await (await reader())([V1], [V2]);
    expect(read.ok && read.skuOf.get(V2)).toBe("SKU-2");
    world.skus = { "1": "SKU-1" };
    expect(await (await reader())([V1], [V2])).toEqual({ ok: false, reason: `no-sku:${V2}` });
  });
});

describe("need / covers / assess", () => {
  const skuOf = new Map([
    [V1, "SKU-1"],
    [V2, "SKU-1"],
  ]);
  const stock = (available: number) =>
    ({ ok: true, bySku: new Map([["SKU-1", { productId: "p", locationId: "10", available }]]), skuOf }) as const;

  it("two lines × 1 against 1 available are short", () => {
    expect(assess(stock(1), [{ variantGid: V1, quantity: 1 }, { variantGid: V2, quantity: 1 }], [])).toEqual({
      kind: "short",
      short: [{ sku: "SKU-1", need: 2, available: 1, earlier: 0 }],
    });
  });

  it("one line × 2 against 1 available is short", () => {
    expect(assess(stock(1), [{ variantGid: V1, quantity: 2 }], []).kind).toBe("short");
  });

  it("earlier demand is subtracted; exactly enough is covered", () => {
    expect(assess(stock(2), [{ variantGid: V1, quantity: 1 }], [{ variantGid: V2, quantity: 1 }])).toEqual({ kind: "covered" });
    expect(assess(stock(2), [{ variantGid: V1, quantity: 1 }], [{ variantGid: V2, quantity: 2 }])).toEqual({
      kind: "short",
      short: [{ sku: "SKU-1", need: 1, available: 2, earlier: 2 }],
    });
  });

  it("an unreadable read is unreadable, never zero", () => {
    expect(assess({ ok: false, reason: "amphora-http:500" }, [{ variantGid: V1, quantity: 1 }], [])).toEqual({
      kind: "unreadable",
      reason: "amphora-http:500",
    });
  });

  it("need sums per SKU and names an unmapped variant", () => {
    expect(need([{ variantGid: V1, quantity: 1 }, { variantGid: V2, quantity: 3 }], skuOf)).toEqual({
      ok: true,
      bySku: new Map([["SKU-1", 4]]),
    });
    expect(need([{ variantGid: "gid://shopify/ProductVariant/9", quantity: 1 }], skuOf)).toEqual({
      ok: false,
      reason: "no-sku:gid://shopify/ProductVariant/9",
    });
  });

  it("covers is per SKU", () => {
    expect(
      covers(new Map([["A", 1], ["B", 1]]), new Map([["A", 1], ["B", 0]]), new Map())
    ).toEqual({ ok: false, short: [{ sku: "B", need: 1, available: 0, earlier: 0 }] });
  });
});
