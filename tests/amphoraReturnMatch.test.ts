import { describe, expect, it } from "vitest";
import { matchConflictAlert, matchReturnsToOrderIds } from "@/lib/amphoraReturnMatch";

// The order link is Amphora's explicit `order_id` (`SHP <shopify order id>`),
// never the shape of the return id: API-created returns are `RET <n>`. Our
// `external_id` marks the record we created. Anything ambiguous is refused and
// reported, never chosen between.

const ORDER = "13192219558214";

// Live shape since ~2026-08-26 (#311523, #311886, #312495).
const ours = { id: "RET 178773180631412224", order_id: `SHP ${ORDER}`, external_id: ORDER };
const shadow = { id: `SHP ${ORDER}`, order_id: `SHP ${ORDER}`, external_id: null };
// Pre-RET shape, and Amphora re-creating a return in their UI (2026-08-05).
const oursLegacy = { id: `SHP ${ORDER}`, order_id: `SHP ${ORDER}`, external_id: ORDER };
const recreated = {
  id: "SHP 13161916465478", order_id: "SHP 13161916465478", external_id: null,
};

describe("matchReturnsToOrderIds", () => {
  it("matches our RET record by order_id and carries its own id", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([ours]);

    expect(matches).toEqual([
      { amphoraReturnId: "RET 178773180631412224", orderId: ORDER, ret: ours, viaExternalId: true },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("picks ours over the PENDING shadow, whichever comes first, and reports nothing", () => {
    for (const listing of [[shadow, ours], [ours, shadow]]) {
      const { matches, conflicts } = matchReturnsToOrderIds(listing);

      expect(matches.map((m) => m.ret)).toEqual([ours]);
      expect(conflicts).toEqual([]);
    }
  });

  it("still matches the legacy shape, where the return id is the SHP order id", () => {
    const { matches } = matchReturnsToOrderIds([oursLegacy]);

    expect(matches[0]).toMatchObject({ amphoraReturnId: `SHP ${ORDER}`, viaExternalId: true });
  });

  it("matches a lone Amphora-created record (no external_id) for its order", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([recreated]);

    expect(matches).toEqual([
      { amphoraReturnId: "SHP 13161916465478", orderId: "13161916465478", ret: recreated, viaExternalId: false },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("never reads the order from the return id: no order_id, no match", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([{ id: `SHP ${ORDER}`, external_id: null }]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("silently drops a record that names no Shopify order and that we did not create", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      { id: "MNL 178172167721430432", order_id: "MNL 178172167721430432", external_id: null },
    ]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("refuses and reports a record whose external_id disagrees with its order_id", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([{ ...ours, external_id: "13100000000000" }]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "external-id-mismatch", amphoraId: "RET 178773180631412224" }),
    ]);
  });

  it("refuses and reports a record we created that names no Shopify order (live: CHN manual)", () => {
    const manual = {
      id: "CHN 178705653566492416", order_id: "CHN 178705653566492416",
      external_id: "manual-310828-blue-xl-2026-09-14",
    };

    const { matches, conflicts } = matchReturnsToOrderIds([manual]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "external-id-mismatch", amphoraId: "CHN 178705653566492416" }),
    ]);
  });

  it("refuses an order with two records we created", () => {
    const second = { ...ours, id: "RET 179000000000000002" };

    const { matches, conflicts } = matchReturnsToOrderIds([ours, shadow, second]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "ambiguous-order", amphoraId: `SHP ${ORDER}`, createdByUs: true }),
    ]);
  });

  it("refuses an order with several records and none of ours — no tie-break on carrier or time", () => {
    const other = { ...shadow, id: "RET 179000000000000003" };

    const { matches, conflicts } = matchReturnsToOrderIds([shadow, other]);

    expect(matches).toEqual([]);
    expect(conflicts).toEqual([
      expect.objectContaining({ kind: "ambiguous-order", orderId: ORDER, createdByUs: false }),
    ]);
  });

  it("refusing one order leaves the rest of the listing matched", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      ours, { ...ours, id: "RET 2" }, recreated,
    ]);

    expect(matches.map((m) => m.orderId)).toEqual(["13161916465478"]);
    expect(conflicts).toHaveLength(1);
  });

  it("treats whitespace around order_id and external_id as the same value", () => {
    const { matches, conflicts } = matchReturnsToOrderIds([
      { id: " RET 1 ", order_id: ` SHP ${ORDER} `, external_id: ` ${ORDER} ` },
    ]);

    expect(conflicts).toEqual([]);
    expect(matches[0]).toMatchObject({ amphoraReturnId: "RET 1", orderId: ORDER, viaExternalId: true });
  });
});

describe("matchConflictAlert", () => {
  it("keys the alert on the Amphora id, so a persisting conflict is one email", () => {
    const alert = matchConflictAlert({
      kind: "ambiguous-order", amphoraId: `SHP ${ORDER}`, orderId: ORDER, createdByUs: true, detail: "2 records we created",
    });

    expect(alert.dedupeKey).toBe(`match-conflict:SHP ${ORDER}`);
    expect(alert.subject).toContain(`SHP ${ORDER}`);
    expect(alert.body).toContain("2 records we created");
  });
});
