import { describe, expect, it } from "vitest";
import {
  originalOrderNumberFromTags,
  planReplacementPricing,
  resolveRootOrderId,
  wasProductSwap,
} from "@/lib/replacementOrigin";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  variant_id: "54623384437062",
  productId: "14958568177990",
  new_variant_id: "gid://shopify/ProductVariant/54623384404294",
  action: "CAMBIO",
  confirmed: true,
  price: "47.03",
  ...over,
}) as any;

describe("originalOrderNumberFromTags", () => {
  it("reads the original from Change + one Order tag", () => {
    expect(
      originalOrderNumberFromTags("amphora_shipped, APH, Change, Order #311749")
    ).toBe("#311749");
  });
  it("is null without the Change tag", () => {
    expect(originalOrderNumberFromTags("Order #311749")).toBeNull();
  });
  it("is null with two Order tags — ambiguous, not guessed", () => {
    expect(originalOrderNumberFromTags("Change, Order #1, Order #2")).toBeNull();
  });
  it("is null for empty or missing tags", () => {
    expect(originalOrderNumberFromTags("")).toBeNull();
    expect(originalOrderNumberFromTags(undefined)).toBeNull();
  });
});

describe("planReplacementPricing", () => {
  it("prices each line at the matching original row (GID vs bare id)", () => {
    const plan = planReplacementPricing(
      [{ variant_id: 54623384404294, product_id: 14958568177990 }],
      [row()]
    );
    expect(plan).toEqual({ ok: true, priceByVariant: { "54623384404294": "47.03" } });
  });
  it("ignores rows that are not confirmed exchanges", () => {
    const plan = planReplacementPricing(
      [{ variant_id: "54623384404294", product_id: "1" }],
      [row({ action: "DEVOLUCIÓN" }), row({ confirmed: false })]
    );
    expect(plan.ok).toBe(false);
  });
  it("fails closed when a line has no match", () => {
    const plan = planReplacementPricing([{ variant_id: "999", product_id: "1" }], [row()]);
    expect(plan).toEqual({ ok: false, reason: "no-original-line:999" });
  });
  it("fails closed when a line matches two original rows", () => {
    const plan = planReplacementPricing(
      [{ variant_id: "54623384404294", product_id: "1" }],
      [row(), row({ variant_id: "other", price: "50" })]
    );
    expect(plan).toEqual({ ok: false, reason: "ambiguous-original-line:54623384404294" });
  });
  it("fails closed with no lines at all", () => {
    expect(planReplacementPricing([], [row()]).ok).toBe(false);
  });
});

describe("resolveRootOrderId", () => {
  it("walks a chain to the order with no exchange_of", async () => {
    const links: Record<string, string | null> = { C: "B", B: "A", A: null };
    await expect(resolveRootOrderId("C", async (id) => links[id] ?? null)).resolves.toBe("A");
  });
  it("returns the start when it is not linked", async () => {
    await expect(resolveRootOrderId("A", async () => null)).resolves.toBe("A");
  });
  it("throws on a cycle instead of looping", async () => {
    const links: Record<string, string> = { A: "B", B: "A" };
    await expect(resolveRootOrderId("A", async (id) => links[id])).rejects.toThrow(/cycle/);
  });
});

describe("wasProductSwap", () => {
  it("is false for a size swap of the same product", () => {
    expect(wasProductSwap([row()], "54623384404294", "14958568177990")).toBe(false);
  });
  it("is true when the replacement is a different product", () => {
    expect(wasProductSwap([row()], "54623384404294", "15296978026822")).toBe(true);
  });
  it("is false when no original row matches", () => {
    expect(wasProductSwap([row()], "1", "2")).toBe(false);
  });
});
