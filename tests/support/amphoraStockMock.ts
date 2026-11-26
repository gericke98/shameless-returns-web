// The Amphora stock reader, mocked at its module boundary
// (`@/lib/server/amphoraStock`), the way other tests mock Shopify at
// lib/settlement/shopify.ts. Each variant gid is its own SKU; `stock.available`
// maps a SKU (= variant gid) to Amphora's `available_quantity`, `stock.reason`
// makes every read unreadable. Default: plenty of everything.
//
//   const stock = vi.hoisted(() => ({ available: {} as Record<string, number>, reason: null as string | null, reads: 0 }));
//   vi.mock("@/lib/server/amphoraStock", async () => (await import("./support/amphoraStockMock")).amphoraStockModule(stock));
import type { StockRead } from "@/lib/stockCoverage";
import { variantGid } from "@/lib/shopifyIds";

export type StockWorld = { available: Record<string, number>; reason: string | null; reads: number };

export const PLENTY = 1000;

export function amphoraStockModule(world: StockWorld) {
  return {
    SHOPIFY_WAREHOUSE_ID: "10",
    readAvailable: async (need: readonly string[], demand: readonly string[] = []): Promise<StockRead> => {
      world.reads++;
      if (world.reason) return { ok: false, reason: world.reason };
      const skuOf = new Map<string, string>();
      for (const id of [...need, ...demand]) {
        const gid = variantGid(id);
        if (!gid) return { ok: false, reason: `bad-variant:${id}` };
        skuOf.set(gid, gid);
      }
      const bySku = new Map(
        need.map((id) => {
          const sku = variantGid(id)!;
          return [sku, { productId: `p-${sku}`, locationId: "10", available: world.available[sku] ?? PLENTY }] as const;
        })
      );
      return { ok: true, bySku, skuOf };
    },
  };
}

export function resetStock(world: StockWorld) {
  world.available = {};
  world.reason = null;
  world.reads = 0;
}
