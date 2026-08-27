import { describe, expect, it } from "vitest";
import { decideAutoApprove, type GateInput } from "@/lib/autoApproveGate";

const NOW = new Date("2026-08-25T12:00:00Z");

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    lines: [
      { id: "l1", variant_id: "v1", quantity: 1, return_id: "gid://shopify/Return/1",
        refunded: false, confirmed: true, sku: "20250503" },
    ],
    amphora: {
      internal_status: "RECEIVED",
      time_received: "2026-08-17T12:56:05",
      items: [{ sku: "20250503", quantity: "1", quantity_received: "1" }],
    },
    shopifyReturnStatus: { "gid://shopify/Return/1": "OPEN" },
    now: NOW,
    graceDays: 2,
    ...over,
  };
}

describe("decideAutoApprove — the happy path", () => {
  it("settles a received, unpaid, out-of-grace return", () => {
    const verdict = decideAutoApprove(input());
    expect(verdict).toEqual({ settle: true, lines: [expect.objectContaining({ id: "l1" })] });
  });

  it("accepts every warehouse status in the allowlist", () => {
    for (const s of ["RECEIVED", "PROCESSING_WAREHOUSE", "FINISHED"]) {
      const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: s } }));
      expect(v.settle, s).toBe(true);
    }
  });
});

describe("decideAutoApprove — Amphora status is an allowlist", () => {
  it("refuses a status we have never seen, rather than assuming it is fine", () => {
    // No EXCEPTION* return exists in live data, so an unknown string is the
    // realistic case — it must not pay anyone out.
    const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: "SOMETHING_NEW" } }));
    expect(v).toEqual({ settle: false, reason: "status-not-in-warehouse:SOMETHING_NEW" });
  });

  it("refuses a return still travelling", () => {
    const v = decideAutoApprove(input({ amphora: { ...input().amphora!, internal_status: "TRAVELLING" } }));
    expect(v.settle).toBe(false);
  });

  it("refuses when there is no Amphora record at all", () => {
    expect(decideAutoApprove(input({ amphora: null }))).toEqual({
      settle: false, reason: "no-amphora-record",
    });
  });
});

describe("decideAutoApprove — quantity_received is a string", () => {
  it('does not settle on quantity_received "0" — the string is truthy', () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: "1", quantity_received: "0" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });

  it('treats "1" and 1 as the same count', () => {
    const asString = decideAutoApprove(input());
    const asNumber = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: 1, quantity_received: 1 }] },
    }));
    expect(asNumber).toEqual(asString);
  });

  it("refuses when the SKU is absent from the Amphora items entirely", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, items: [{ sku: "OTHER", quantity: "1", quantity_received: "1" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });

  it("refuses when we could not resolve our own line to a SKU", () => {
    const v = decideAutoApprove(input({
      lines: [{ ...input().lines[0], sku: null }],
    }));
    expect(v).toEqual({ settle: false, reason: "unresolved-sku:v1" });
  });

  it("does not let two lines of the same SKU both claim one received garment", () => {
    // The customer declared two of the same garment; one came back.
    const v = decideAutoApprove(input({
      lines: [
        { ...input().lines[0], id: "l1" },
        { ...input().lines[0], id: "l2" },
      ],
      amphora: { ...input().amphora!, items: [{ sku: "20250503", quantity: "2", quantity_received: "1" }] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250503" });
  });
});

describe("decideAutoApprove — one short line holds the whole order", () => {
  it("settles nothing when a sibling line is short", () => {
    const v = decideAutoApprove(input({
      lines: [
        { id: "l1", variant_id: "v1", quantity: 1, return_id: "gid://shopify/Return/1",
          refunded: false, confirmed: true, sku: "20250503" },
        { id: "l2", variant_id: "v2", quantity: 1, return_id: "gid://shopify/Return/1",
          refunded: false, confirmed: true, sku: "20250504" },
      ],
      amphora: { ...input().amphora!, items: [
        { sku: "20250503", quantity: "1", quantity_received: "1" },
        { sku: "20250504", quantity: "1", quantity_received: "0" },
      ] },
    }));
    expect(v).toEqual({ settle: false, reason: "short-receipt:20250504" });
  });
});

describe("decideAutoApprove — Shopify says whether we already paid", () => {
  it("refuses a CLOSED return — 52 of 168 lines were in this state", () => {
    const v = decideAutoApprove(input({
      shopifyReturnStatus: { "gid://shopify/Return/1": "CLOSED" },
    }));
    expect(v).toEqual({ settle: false, reason: "shopify-not-open:CLOSED" });
  });

  it("refuses a CANCELED return", () => {
    const v = decideAutoApprove(input({
      shopifyReturnStatus: { "gid://shopify/Return/1": "CANCELED" },
    }));
    expect(v).toEqual({ settle: false, reason: "shopify-not-open:CANCELED" });
  });

  it("refuses when the status could not be read — absence is never OPEN", () => {
    const v = decideAutoApprove(input({ shopifyReturnStatus: {} }));
    expect(v).toEqual({ settle: false, reason: "shopify-unreadable:gid://shopify/Return/1" });
  });

  it("refuses a line carrying no return id", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], return_id: null }] }));
    expect(v).toEqual({ settle: false, reason: "no-return-id:l1" });
  });
});

describe("decideAutoApprove — the grace period", () => {
  it("refuses a return received an hour ago", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-25T11:00:00" },
    }));
    expect(v).toEqual({ settle: false, reason: "within-grace" });
  });

  it("reads a bare stamp as UTC, not as the runner's local time", () => {
    // Bare and offset-aware forms of the same instant must decide identically,
    // or the job behaves differently on a laptop than on Vercel.
    const bare = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-23T11:59:00" },
    }));
    const offset = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: "2026-08-23T11:59:00+00:00" },
    }));
    expect(bare).toEqual(offset);
  });

  it("refuses when there is no receipt timestamp to measure from", () => {
    const v = decideAutoApprove(input({
      amphora: { ...input().amphora!, time_received: null },
    }));
    expect(v).toEqual({ settle: false, reason: "no-receipt-timestamp" });
  });
});

describe("decideAutoApprove — nothing to do", () => {
  it("reports nothing-to-settle when every line is already refunded", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], refunded: true }] }));
    expect(v).toEqual({ settle: false, reason: "nothing-to-settle" });
  });

  it("ignores unconfirmed lines entirely", () => {
    const v = decideAutoApprove(input({ lines: [{ ...input().lines[0], confirmed: false }] }));
    expect(v).toEqual({ settle: false, reason: "nothing-to-settle" });
  });
});
