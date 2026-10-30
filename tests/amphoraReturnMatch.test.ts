import { describe, expect, it } from "vitest";
import { matchConflictAlert, matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";

// Amphora's return id is `SHP <shopify order id>`, which is also our
// `orders.id`. It is the only key: `external_id` is data that must agree with
// it, and anything ambiguous is refused and reported, never chosen between.

const withExternal = {
  id: "SHP 13192219558214",
  name: "#310957",
  external_id: "13192219558214",
};

const orphan = {
  id: "SHP 13161916465478",
  name: "#310761",
  external_id: null,
};

describe("matchReturnsToOrderIds", () => {
  it("matches a return we created by the order id inside its return id", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([withExternal]);

    expect(matches).toEqual([
      { orderId: "13192219558214", ret: withExternal, viaExternalId: true },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("matches an Amphora-created return (no external_id) by its return id alone", () => {
    // The 2026-08-05 case: Amphora deleted our record and re-created it in
    // their UI. One record under the id, external_id null, still matched.
    const { matches, conflicts } = matchReturnsToOrderIds([orphan]);

    expect(matches).toEqual([
      { orderId: "13161916465478", ret: orphan, viaExternalId: false },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("matches one record per id across a listing of several orders", () => {
    const { matches } = matchReturnsToOrderIds([withExternal, orphan]);

    expect(matches.map((m) => m.orderId).sort()).toEqual([
      "13161916465478",
      "13192219558214",
    ]);
  });

  it("silently drops a return whose id names no order and that we did not create", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      { id: "MNL 999", name: "#310000", external_id: null },
    ]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses and reports a record whose external_id disagrees with its id", () => {
    const bad = { ...withExternal, external_id: "13100000000000" };

    const { matches, conflicts } = matchReturnsToOrderIds([bad]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: "external-id-mismatch",
        amphoraReturnId: "SHP 13192219558214",
      }),
    ]);
  });

  it("refuses and reports a record we created whose id names no order", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      { id: "MNL 999", external_id: "13192219558214" },
    ]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "external-id-mismatch", amphoraReturnId: "MNL 999" }),
    ]);
  });

  it("refuses the whole order when two records share one return id, whichever is ours", () => {
    // Before: carrier presence, creation time and first-seen decided which one
    // to sync. Now nobody chooses; a human looks.
    const ours = { ...withExternal, carrier: null };
    const theirs = { ...orphan, id: withExternal.id, carrier: "UPS" };

    for (const listing of [[ours, theirs], [theirs, ours]]) {
      const { matches, conflicts } = matchReturnsToOrderIds(listing);

      expect(matches).toEqual([]);
      expect(conflicts).toEqual([
        expect.objectContaining({ kind: "duplicate-id", amphoraReturnId: "SHP 13192219558214" }),
      ]);
    }
  });

  it("refusing one order leaves the rest of the listing matched", () => {
    const dupA = { ...withExternal };
    const dupB = { ...withExternal, external_id: null };

    const { matches, conflicts } = matchReturnsToOrderIds([dupA, orphan, dupB]);

    expect(matches.map((m) => m.orderId)).toEqual(["13161916465478"]);
    expect(conflicts).toHaveLength(1);
  });

  it("treats whitespace around the id and external_id as the same id", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      { id: " SHP 13192219558214 ", external_id: " 13192219558214 " },
    ]);

    expect(conflicts).toEqual([]);
    expect(matches[0].orderId).toBe("13192219558214");
    expect(matches[0].viaExternalId).toBe(true);
  });
});

describe("matchConflictAlert", () => {
  it("keys the alert on the Amphora return id, so a persisting conflict is one email", () => {
    const conflict = {
      kind: "duplicate-id" as const,
      amphoraReturnId: "SHP 13192219558214",
      detail: "2 records under one return id",
    };

    const alert = matchConflictAlert(conflict);

    expect(alert.dedupeKey).toBe("match-conflict:SHP 13192219558214");
    expect(alert.subject).toContain("SHP 13192219558214");
    expect(alert.body).toContain("2 records under one return id");
  });
});
