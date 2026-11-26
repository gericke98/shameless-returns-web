// FX §#1: at submit, the exact agreement about to be saved is checked against
// Amphora BEFORE anything is proposed or charged (Codex #1). Amphora is mocked
// at its reader's module boundary; open demand at the ledger's read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const basketLines = vi.hoisted(() => ({ value: [] as any[] }));
const proposeSubmission = vi.hoisted(() => vi.fn());
const openDemand = vi.hoisted(() => ({ value: [] as any[] }));
const stock = vi.hoisted(() => ({ available: {} as Record<string, number>, reason: null as string | null, reads: 0 }));

vi.mock("@/lib/server/amphoraStock", async () => (await import("./support/amphoraStockMock")).amphoraStockModule(stock));
vi.mock("@/lib/settlement/ledger", () => ({ openExchangeDemand: async () => openDemand.value }));
vi.mock("@/db/fees", () => ({ getFeeTable: vi.fn(async () => ({})) }));
vi.mock("@/db/queries", () => ({ getOrderTotal: vi.fn(async () => ({})) }));
vi.mock("@/lib/server/submissionScope", () => ({ proposeSubmission }));
vi.mock("@/lib/feeLegs", () => ({ feeLegsForOrder: vi.fn(() => ({})) }));
vi.mock("@/lib/fees", () => ({
  resolveFee: vi.fn(() => ({ feeCents: 500, returnLegCents: 500, outboundLegCents: 0 })),
}));
vi.mock("@/lib/fulfillmentLines", () => ({
  resolveFulfillmentLineItems: vi.fn(
    async (sel: Array<{ productsorderId: number }>) =>
      new Map(sel.map((s) => [s.productsorderId, `gid://shopify/FulfillmentLineItem/${s.productsorderId}`]))
  ),
}));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: vi.fn(async () => ({
    order: {
      products: basketLines.value.map((l) => ({ id: l.id, lineItemId: `li${l.id}`, new_variant_id: l.newVariantId ?? null })),
    },
    basket: { hasItems: basketLines.value.length > 0, lines: basketLines.value },
  })),
}));

import { proposeCurrentSelection } from "@/lib/submissionProposal";
import { vid, vsub } from "./support/verified";
import { resetStock } from "./support/amphoraStockMock";

const V = "gid://shopify/ProductVariant/9";
const exchange = (id: number, quantity = 1) => ({
  id,
  action: "CAMBIO",
  quantity,
  returnedCents: 5000,
  replacementCents: 9000,
  degraded: false,
  newVariantId: V,
});
const refund = (id: number) => ({ id, action: "DEVOLUCION", quantity: 1, returnedCents: 5000, replacementCents: 0, degraded: false });

describe("submit refuses a replacement Amphora cannot cover", () => {
  beforeEach(() => {
    resetStock(stock);
    openDemand.value = [];
    proposeSubmission.mockReset();
    proposeSubmission.mockResolvedValue({ ok: true, submission: vsub("o1", "sub-1") });
  });

  it("covered → proposed", async () => {
    basketLines.value = [exchange(1)];
    stock.available[V] = 1;
    expect(await proposeCurrentSelection(vid("o1"), null, "CORREOS")).toMatchObject({ ok: true });
    expect(proposeSubmission).toHaveBeenCalledOnce();
  });

  it("two lines × 1 against 1 → replacement-unavailable, nothing proposed", async () => {
    basketLines.value = [exchange(1), exchange(2)];
    stock.available[V] = 1;
    expect(await proposeCurrentSelection(vid("o1"), null, "CORREOS")).toEqual({ ok: false, reason: "replacement-unavailable" });
    expect(proposeSubmission).not.toHaveBeenCalled();
  });

  it("an accepted promise elsewhere takes the last unit → replacement-unavailable", async () => {
    basketLines.value = [exchange(1)];
    stock.available[V] = 1;
    openDemand.value = [{ submissionId: "s0", acceptedAt: new Date(), variantGid: V, quantity: 1 }];
    expect(await proposeCurrentSelection(vid("o1"), null, "CORREOS")).toEqual({ ok: false, reason: "replacement-unavailable" });
    expect(proposeSubmission).not.toHaveBeenCalled();
  });

  it("Amphora unreadable → stock-unreadable, nothing proposed", async () => {
    basketLines.value = [exchange(1)];
    stock.reason = "amphora-transport:timeout";
    expect(await proposeCurrentSelection(vid("o1"), null, "CORREOS")).toEqual({ ok: false, reason: "stock-unreadable" });
    expect(proposeSubmission).not.toHaveBeenCalled();
  });

  it("a pure return never reads Amphora", async () => {
    basketLines.value = [refund(1)];
    expect(await proposeCurrentSelection(vid("o1"), false, "CORREOS")).toMatchObject({ ok: true });
    expect(stock.reads).toBe(0);
  });
});

describe("the refusals have words in both languages", () => {
  it("es and en name both", async () => {
    const { es } = await import("@/lib/i18n/es");
    const { en } = await import("@/lib/i18n/en");
    for (const dict of [es, en]) {
      expect(dict.action.replacementUnavailable).toMatch(/\w/);
      expect(dict.action.stockUnreadable).toMatch(/\w/);
    }
  });
});
