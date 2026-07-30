import { describe, expect, it } from "vitest";
import { decideWebhookActions, orderIdFromWebhook } from "@/lib/amphoraWebhook";

const FRESH = { returnStatus: null, locator: null };

describe("orderIdFromWebhook", () => {
  it("strips the SHP prefix Amphora puts on our order id", () => {
    expect(orderIdFromWebhook({ id: "SHP 13194624794950" })).toBe(
      "13194624794950"
    );
  });

  it("returns null when the id is not one of ours", () => {
    expect(orderIdFromWebhook({ id: "RET-9912" })).toBeNull();
    expect(orderIdFromWebhook({})).toBeNull();
  });
});

describe("decideWebhookActions", () => {
  it("treats a repeat of the current status as a no-op", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "TRAVELLING", carrier_number: "1Z999" }
    );
    expect(actions.noop).toBe(true);
    expect(actions.emails).toEqual([]);
    expect(actions.persist).toBeNull();
  });

  it("ignores a payload with no status", () => {
    expect(decideWebhookActions(FRESH, {}).noop).toBe(true);
  });

  it("sends tracking the first time a carrier appears", () => {
    const actions = decideWebhookActions(FRESH, {
      internal_status: "APROVED",
      carrier: "UPS",
      carrier_number: "1Z999",
      carrier_url: "https://ups.com/1Z999",
    });
    expect(actions.emails).toEqual(["collectionScheduled"]);
    expect(actions.persist).toEqual({
      returnStatus: "APROVED",
      locator: "1Z999",
      carrier: "UPS",
      carrierUrl: "https://ups.com/1Z999",
    });
  });

  it("does not resend tracking when we already have it", () => {
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "1Z999" },
      { internal_status: "TRAVELLING", carrier_number: "1Z999" }
    );
    expect(actions.emails).toEqual([]);
    expect(actions.persist?.returnStatus).toBe("TRAVELLING");
  });

  it("emails on arrival at the warehouse", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "RECEIVED" }
    );
    expect(actions.emails).toEqual(["returnReceived"]);
  });

  it("records an approval with no carrier without emailing", () => {
    // Exactly #310972: approved, warehouse assigned, carrier still pending.
    const actions = decideWebhookActions(FRESH, { internal_status: "APROVED" });
    expect(actions.emails).toEqual([]);
    expect(actions.persist).toEqual({ returnStatus: "APROVED" });
  });

  it("never emails the customer about an exception", () => {
    for (const status of ["EXCEPTION", "EXCEPTION_WAREHOUSE"]) {
      const actions = decideWebhookActions(FRESH, { internal_status: status });
      expect(actions.emails).toEqual([]);
      expect(actions.persist?.returnStatus).toBe(status);
    }
  });

  it("does not clobber known tracking with a payload that omits it", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z999" },
      { internal_status: "RECEIVED" }
    );
    expect(actions.persist).not.toHaveProperty("locator");
  });
});
