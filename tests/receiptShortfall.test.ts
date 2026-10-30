import { describe, expect, it } from "vitest";
import { shortfallsBySku, type ShortfallLine } from "@/lib/receiptShortfall";

// One Amphora return = one pool. Per SKU: supply = received − settled,
// demand = pending; short when demand > supply. `unknown` is neither short nor
// fine: callers must not act on it either way.

const line = (over: Partial<ShortfallLine> = {}): ShortfallLine => ({
  variant_id: "v1", quantity: 1, refunded: false, confirmed: true, sku: "A", ...over,
});
const item = (sku: string, received: number | string) => ({ sku, quantity_received: received });

describe("shortfallsBySku", () => {
  it("is ok when every declared unit was counted in", () => {
    expect(shortfallsBySku([line()], [item("A", "1")])).toEqual({ status: "ok" });
  });

  it("#312246: two-line exchange, one garment kept", () => {
    // Real counts: 20240800 = 0, 20252901 = 1.
    const v = shortfallsBySku(
      [line({ variant_id: "v1", sku: "20240800" }), line({ variant_id: "v2", sku: "20252901" })],
      [item("20240800", "0"), item("20252901", "1")]
    );

    expect(v).toEqual({ status: "short", skus: [{ sku: "20240800", declared: 1, received: 0 }] });
  });

  it("single line with 0 received is short", () => {
    expect(shortfallsBySku([line()], [item("A", "0")])).toEqual({
      status: "short", skus: [{ sku: "A", declared: 1, received: 0 }],
    });
  });

  it("a SKU missing from the Amphora items counts as 0 received", () => {
    expect(shortfallsBySku([line()], [item("B", "1")]).status).toBe("short");
  });

  it("pools same-SKU lines: two lines, one unit received, is short by the aggregate", () => {
    expect(shortfallsBySku([line({ id: "1" } as any), line()], [item("A", "1")])).toEqual({
      status: "short", skus: [{ sku: "A", declared: 2, received: 1 }],
    });
  });

  it("sums duplicate SKU entries in the Amphora items", () => {
    expect(shortfallsBySku([line({ quantity: 2 })], [item("A", "1"), item("A", "1")])).toEqual({
      status: "ok",
    });
  });

  it("quantity 2 with 1 received is short", () => {
    expect(shortfallsBySku([line({ quantity: 2 })], [item("A", 1)])).toEqual({
      status: "short", skus: [{ sku: "A", declared: 2, received: 1 }],
    });
  });

  it("a settled sibling consumes its unit: the pending line is short", () => {
    const v = shortfallsBySku([line({ refunded: true }), line()], [item("A", "1")]);

    expect(v).toEqual({ status: "short", skus: [{ sku: "A", declared: 2, received: 1 }] });
  });

  it("is ok when everything of a short SKU is already settled — nothing left to hold", () => {
    expect(shortfallsBySku([line({ refunded: true })], [item("A", "0")])).toEqual({ status: "ok" });
  });

  it("ignores unconfirmed lines entirely", () => {
    expect(shortfallsBySku([line({ confirmed: false, sku: null })], [])).toEqual({ status: "ok" });
  });

  it("is unknown, not short, on a NaN count for a SKU we need", () => {
    expect(shortfallsBySku([line()], [item("A", "n/a")])).toEqual({
      status: "unknown", reason: "unreadable-count:A",
    });
  });

  it("ignores a NaN count on a SKU that is not ours", () => {
    expect(shortfallsBySku([line()], [item("A", "1"), item("Z", "??")])).toEqual({ status: "ok" });
  });

  it("is unknown when any confirmed line's SKU is unresolved, settled ones included", () => {
    expect(shortfallsBySku([line({ refunded: true, sku: null, variant_id: "v9" }), line()], [item("A", "1")]))
      .toEqual({ status: "unknown", reason: "unresolved-sku:v9" });
  });

  it("is unknown on an unreadable line quantity", () => {
    expect(shortfallsBySku([line({ quantity: NaN })], [item("A", "1")]).status).toBe("unknown");
  });
});
