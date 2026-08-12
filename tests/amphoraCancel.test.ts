import { beforeEach, describe, expect, it, vi } from "vitest";

// Amphora is the only booking either lane lets us release. Correos exposes no
// cancellation reachable with our credentials, so if this call does not happen
// the warehouse expects a parcel that is never coming.

const calls: Array<{ method: string; url: string; data: unknown }> = [];
let failNext = false;

vi.mock("axios", () => ({
  default: {
    request: async (cfg: any) => {
      if (failNext) throw new Error("amphora 500");
      calls.push({ method: cfg.method, url: cfg.url, data: cfg.data });
      return { data: { return_order: { id: "SHP 123", internal_status: "CANCELLED" } } };
    },
  },
}));

beforeEach(() => {
  calls.length = 0;
  failNext = false;
  process.env.AMPHORA_API_KEY = "k";
  process.env.AMPHORA_TENANT_ID = "Shameless";
  process.env.AMPHORA_COMPANY_API_URL = "https://api.example.com/prod-integrations-api";
});

describe("cancelAmphoraReturn", () => {
  it("PATCHes the cancel endpoint for that return", async () => {
    const { cancelAmphoraReturn } = await import("@/actions/amphora");

    await cancelAmphoraReturn("SHP 123");

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/returns/SHP%20123/cancel");
  });

  it("returns the cancelled return", async () => {
    const { cancelAmphoraReturn } = await import("@/actions/amphora");

    const result = await cancelAmphoraReturn("SHP 123");

    expect(result.id).toBe("SHP 123");
  });

  it("throws when Amphora refuses, so the caller can abort", async () => {
    // The orchestrator treats this as fatal: nothing else may run, because a
    // refund past this point would leave the warehouse expecting a parcel.
    const { cancelAmphoraReturn } = await import("@/actions/amphora");
    failNext = true;

    await expect(cancelAmphoraReturn("SHP 123")).rejects.toThrow();
  });
});
