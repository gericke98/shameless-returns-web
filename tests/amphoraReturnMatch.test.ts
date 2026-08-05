import { describe, expect, it } from "vitest";
import { matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";

// Amphora's return id is `SHP <shopify order id>`, which is also our
// `orders.id`. That is the only link back when they create the return
// themselves, because then `external_id` is null.

const withExternal = {
  id: "SHP 13192219558214",
  name: "#310957",
  external_id: "13192219558214",
  time: "2026-08-01T10:00:00",
};

const orphan = {
  id: "SHP 13161916465478",
  name: "#310761",
  external_id: null,
  time: "2026-08-05T06:25:20",
};

describe("matchReturnsToOrderIds", () => {
  it("keys a return we created by its external_id", () => {
    const [match] = matchReturnsToOrderIds([withExternal]);

    expect(match.orderId).toBe("13192219558214");
    expect(match.viaExternalId).toBe(true);
  });

  it("recovers the order id of an Amphora-created return from the SHP prefix", () => {
    const [match] = matchReturnsToOrderIds([orphan]);

    expect(match.orderId).toBe("13161916465478");
    expect(match.viaExternalId).toBe(false);
  });

  it("drops a return with no external_id and no SHP prefix", () => {
    const matches = matchReturnsToOrderIds([
      { id: "MNL 999", name: "#310000", external_id: null, time: null },
    ]);

    expect(matches).toEqual([]);
  });

  it("prefers the return we created when both exist for one order", () => {
    const ours = { ...withExternal, id: "SHP 13192219558214" };
    const theirs = { ...orphan, id: "SHP 13192219558214", name: "#310957" };

    const matches = matchReturnsToOrderIds([theirs, ours]);

    expect(matches).toHaveLength(1);
    expect(matches[0].viaExternalId).toBe(true);
  });

  it("keeps the newest when an order has two Amphora-created returns", () => {
    const older = { ...orphan, time: "2026-08-04T06:00:00" };
    const newer = { ...orphan, time: "2026-08-05T06:25:20" };

    const matches = matchReturnsToOrderIds([older, newer]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ret.time).toBe("2026-08-05T06:25:20");
  });

  it("treats a missing timestamp as oldest rather than throwing", () => {
    const undated = { ...orphan, time: null };
    const dated = { ...orphan, time: "2026-08-05T06:25:20" };

    const matches = matchReturnsToOrderIds([dated, undated]);

    expect(matches[0].ret.time).toBe("2026-08-05T06:25:20");
  });

  it("still prefers the return we created even when processed first with an older timestamp", () => {
    // Regression test: without the `if (held.viaExternalId) continue;` guard,
    // a newer Amphora-created return would overwrite an older one we created.
    // This test processes the one we created first, making it the "held" value,
    // then tests that timestamp comparison does not override the viaExternalId preference.
    const ours = { ...withExternal, id: "SHP 13192219558214", time: "2026-08-01T10:00:00" };
    const theirs = { ...orphan, id: "SHP 13192219558214", time: "2026-08-05T06:25:20" };

    const matches = matchReturnsToOrderIds([ours, theirs]);

    expect(matches).toHaveLength(1);
    expect(matches[0].viaExternalId).toBe(true);
  });
});
