import { describe, expect, it } from "vitest";
import { resolveRootOrderId } from "@/lib/replacementOrigin";

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
