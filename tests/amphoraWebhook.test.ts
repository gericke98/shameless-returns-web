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
      // Recorded even though APROVED sends `collectionScheduled` rather than a
      // tracking email: the KEY is what stops a later flap re-announcing an
      // earlier milestone, so it has to be written for every phase, not only
      // the two that email.
      lastTrackingKey: "accepted",
      lastTrackingLocator: "1Z999",
    });
  });

  it("does not resend tracking when we already have it", () => {
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "1Z999" },
      { internal_status: "TRAVELLING", carrier_number: "1Z999" }
    );
    // Narrower than `toEqual([])` on purpose: TRAVELLING now also emits an
    // in-transit notice, and this test is about not sending the tracking
    // email twice — not about the list being empty.
    expect(actions.emails).not.toContain("collectionScheduled");
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

  it("now DOES tell the customer about an exception", () => {
    // Reversed deliberately on 2026-08-27. This used to assert silence, which
    // documented the old behaviour rather than a decision: an exception is the
    // one state where the customer may need to act, and staying quiet is how
    // #310664 sat stranded for three weeks while a log line repeated unread.
    //
    // The order now carries a locator. It used to be FRESH — see the test
    // directly below for why that no longer sends.
    for (const status of ["EXCEPTION", "EXCEPTION_WAREHOUSE"]) {
      const actions = decideWebhookActions(
        { returnStatus: "TRAVELLING", locator: "1Z999" },
        { internal_status: status }
      );
      expect(actions.emails, status).toContain("trackingProblem");
      expect(actions.persist?.returnStatus).toBe(status);
    }
  });

  it("stays quiet about an exception on a return with no parcel identity", () => {
    // A KNOWN GAP, pinned so it is visible rather than discovered.
    //
    // The milestone decision is keyed on the parcel: without a carrier number
    // — ours or Amphora's — there is nothing to record the milestone AGAINST,
    // so nothing can stop a status that flaps from emailing on every 15-minute
    // poll. Silence is the safe direction, but it is silence: a return that
    // hits EXCEPTION before a carrier is ever assigned tells neither the
    // customer nor ops. Amphora assigns carriers synchronously on a fresh
    // booking, so this is the stranded-return case, not the common one.
    const actions = decideWebhookActions(FRESH, { internal_status: "EXCEPTION" });

    expect(actions.emails).toEqual([]);
    expect(actions.persist?.returnStatus).toBe("EXCEPTION");
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

describe("decideWebhookActions — the two milestones international was missing", () => {
  it("announces TRAVELLING once", () => {
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "TRAVELLING" } as any
    );
    expect(actions.emails).toContain("trackingInTransit");
  });

  it("does not re-announce TRAVELLING on an unchanged status", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "TRAVELLING" } as any
    );
    expect(actions.noop).toBe(true);
  });

  it("reports every exception shape as a problem", () => {
    for (const status of ["EXCEPTION", "EXCEPTION_WAREHOUSE", "EXCEPTION_HOLD", "FINISHED_REJECTED"]) {
      const actions = decideWebhookActions(
        { returnStatus: "TRAVELLING", locator: "1Z1" },
        { id: "SHP 1", name: "#1", internal_status: status } as any
      );
      expect(actions.emails, status).toContain("trackingProblem");
    }
  });

  it("still sends returnReceived, and does NOT add a second arrival email", () => {
    const actions = decideWebhookActions(
      { returnStatus: "TRAVELLING", locator: "1Z1" },
      { id: "SHP 1", name: "#1", internal_status: "RECEIVED" } as any
    );
    expect(actions.emails).toContain("returnReceived");
    expect(actions.emails).not.toContain("trackingInTransit");
  });

  it("sends one email, not two, when the carrier first appears on TRAVELLING", () => {
    // The carrier can first appear on APROVED or on TRAVELLING. When it lands
    // on TRAVELLING both notices would otherwise fire for one event.
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: null },
      {
        internal_status: "TRAVELLING",
        carrier: "DHL",
        carrier_number: "JJD001",
        carrier_url: "https://dhl.example/JJD001",
      } as any
    );

    expect(actions.emails).toEqual(["collectionScheduled"]);
  });

  it("does not re-announce transit when a customs hold clears", () => {
    // THE case this rank table exists for. TRAVELLING -> EXCEPTION_HOLD ->
    // TRAVELLING is an ordinary customs hold, every leg of it is a status
    // CHANGE, and `amphora-sync` polls every 15 minutes — so dedupe-on-status
    // bounded nothing. A parcel held at the border would email its customer
    // "on its way" and "there is a problem" alternately, all day.
    //
    // Threaded through the persisted state the way the sync actually does it,
    // rather than hand-fed, so the assertion depends on what the previous call
    // wrote.
    const order: any = { returnStatus: "APROVED", locator: "1Z1" };
    const apply = (status: string) => {
      const actions = decideWebhookActions(order, { internal_status: status } as any);
      if (actions.persist) Object.assign(order, actions.persist);
      return actions.emails;
    };

    expect(apply("TRAVELLING")).toEqual(["trackingInTransit"]);
    expect(apply("EXCEPTION_HOLD")).toEqual(["trackingProblem"]);
    // Back on the move. The customer has already been told both things; the
    // only thing left worth saying is that it arrived.
    expect(apply("TRAVELLING")).toEqual([]);
    expect(apply("EXCEPTION_HOLD")).toEqual([]);
    expect(apply("RECEIVED")).toEqual(["returnReceived"]);
  });

  it("does not re-announce transit for a parcel already delivered", () => {
    // The other direction of the same flap: Amphora moving a received parcel
    // back to TRAVELLING must not tell the customer it is travelling again.
    const actions = decideWebhookActions(
      {
        returnStatus: "RECEIVED",
        locator: "1Z1",
        lastTrackingKey: "received",
        lastTrackingLocator: "1Z1",
      },
      { internal_status: "TRAVELLING" } as any
    );

    expect(actions.emails).toEqual([]);
  });

  it("starts the journey over when the parcel is a different one", () => {
    // A re-registration produces a new carrier number. Whatever the previous
    // parcel reached says nothing about this one.
    const actions = decideWebhookActions(
      {
        returnStatus: "RECEIVED",
        locator: "1Z-OLD",
        lastTrackingKey: "received",
        lastTrackingLocator: "1Z-OLD",
      },
      { internal_status: "TRAVELLING", carrier_number: "1Z-NEW" } as any
    );

    expect(actions.emails).toContain("trackingInTransit");
    expect(actions.persist?.lastTrackingLocator).toBe("1Z-NEW");
  });

  it("still announces transit when the tracking email is not firing", () => {
    // The control: with a locator already stored, collectionScheduled is
    // disarmed, so the in-transit notice is the only thing to say.
    const actions = decideWebhookActions(
      { returnStatus: "APROVED", locator: "JJD001" },
      { internal_status: "TRAVELLING", carrier_number: "JJD001" } as any
    );

    expect(actions.emails).toEqual(["trackingInTransit"]);
  });
});
