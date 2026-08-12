import { describe, expect, it } from "vitest";
import {
  UNKNOWN_CARRIER,
  decideWebhookActions,
  orderIdFromWebhook,
} from "@/lib/amphoraWebhook";
import { tracksWithCorreos } from "@/lib/trackingStatus";

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

  // A null `carrier` is not "unknown" — it MEANS "our own domestic Correos
  // label", and that is what gates the Correos tracking lookup. If Amphora
  // introduces a tracking number without naming the carrier, the row would
  // silently claim to be a Correos shipment: the localizador would be asked
  // about a UPS code, answer "no traceability", and the cancel gate would fail
  // closed forever. Never seen in production (zero rows carry that signature),
  // so this closes the hole rather than fixing an incident.
  it("names the carrier when Amphora introduces tracking without one", () => {
    const actions = decideWebhookActions(FRESH, {
      internal_status: "APROVED",
      carrier_number: "1Z999",
    });

    expect(actions.persist?.locator).toBe("1Z999");
    expect(actions.persist?.carrier).toBe(UNKNOWN_CARRIER);
  });

  it("leaves a domestic Correos label's null carrier alone", () => {
    // The domestic lane writes `locator` itself and leaves `carrier` null. A
    // later Amphora poll that echoes the number back must NOT overwrite that —
    // stamping it UNKNOWN would stop us checking Correos for a parcel the
    // customer may already have deposited, and let them cancel it.
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "PQAZXT9800005420128110D" },
      { internal_status: "TRAVELLING", carrier_number: "PQAZXT9800005420128110D" }
    );

    expect(actions.persist).not.toHaveProperty("carrier");
  });

  it("prefers the carrier Amphora actually names", () => {
    const actions = decideWebhookActions(FRESH, {
      internal_status: "APROVED",
      carrier_number: "1Z999",
      carrier: "UPS",
    });

    expect(actions.persist?.carrier).toBe("UPS");
  });

  it("records a carrier that arrives with no tracking number", () => {
    const actions = decideWebhookActions(FRESH, {
      internal_status: "APROVED",
      carrier: "UPS",
    });

    expect(actions.persist?.carrier).toBe("UPS");
    expect(actions.persist).not.toHaveProperty("locator");
  });

  it("invents no carrier when there is no tracking either", () => {
    const actions = decideWebhookActions(FRESH, { internal_status: "APROVED" });

    expect(actions.persist).not.toHaveProperty("carrier");
  });

  it("uses a placeholder the Correos lookup will not match", () => {
    // The whole point of the placeholder is that it fails `tracksWithCorreos`.
    expect(tracksWithCorreos(UNKNOWN_CARRIER)).toBe(false);
  });
});
