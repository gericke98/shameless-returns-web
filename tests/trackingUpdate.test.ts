import { describe, expect, it } from "vitest";
import { decideTrackingUpdate, keyForPhase, type TrackingUpdateInput } from "@/lib/trackingUpdate";

function input(over: Partial<TrackingUpdateInput> = {}): TrackingUpdateInput {
  return {
    lastKey: null,
    lastLocator: null,
    currentLocator: "PQ1",
    phase: "admitido",
    ...over,
  };
}

describe("keyForPhase", () => {
  it("maps both travelling phases onto one key", () => {
    // Otherwise a parcel moving depot -> depot -> out-for-delivery emails
    // three times about a journey the customer cannot act on.
    expect(keyForPhase("en_transito")).toBe("in_transit");
    expect(keyForPhase("en_reparto")).toBe("in_transit");
  });

  it("maps the milestones customers actually ask about", () => {
    expect(keyForPhase("admitido")).toBe("accepted");
    expect(keyForPhase("entregado")).toBe("received");
    expect(keyForPhase("incidencia")).toBe("problem");
  });

  it("has no key for a phase that is not news", () => {
    expect(keyForPhase("prerregistrado")).toBeNull();
    expect(keyForPhase("sin_informacion")).toBeNull();
  });
});

describe("decideTrackingUpdate — sin_informacion is not a state", () => {
  it("neither emails nor persists when Correos knows nothing", () => {
    // Correos answers HTTP 200 with codError "3" and every field null for a
    // parcel it cannot trace. 82 of 415 live locators were in that state.
    expect(decideTrackingUpdate(input({ phase: "sin_informacion" }))).toEqual({
      notify: null,
      persist: null,
    });
  });

  it("does not overwrite a known key when the parcel goes untraceable", () => {
    // The failure this prevents: "we've lost your return", then a second email
    // when it reappears.
    const decision = decideTrackingUpdate(
      input({ phase: "sin_informacion", lastKey: "received", lastLocator: "PQ1" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("says nothing about a parcel that is only pre-registered", () => {
    expect(decideTrackingUpdate(input({ phase: "prerregistrado" }))).toEqual({
      notify: null,
      persist: null,
    });
  });
});

describe("decideTrackingUpdate — first news about a parcel", () => {
  it("notifies and persists when we have told the customer nothing", () => {
    expect(decideTrackingUpdate(input())).toEqual({
      notify: "accepted",
      persist: { lastTrackingKey: "accepted", lastTrackingLocator: "PQ1" },
    });
  });

  it("does nothing without a locator to speak of", () => {
    expect(decideTrackingUpdate(input({ currentLocator: null }))).toEqual({
      notify: null,
      persist: null,
    });
  });
});

describe("decideTrackingUpdate — the same news twice", () => {
  it("is a no-op when the key is unchanged", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "admitido" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("sends one in_transit for en_transito then en_reparto", () => {
    const first = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "en_transito" })
    );
    expect(first.notify).toBe("in_transit");

    const second = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "en_reparto" })
    );
    expect(second).toEqual({ notify: null, persist: null });
  });
});

describe("decideTrackingUpdate — never notify backwards", () => {
  it("ignores a regression from received to in transit", () => {
    // Correos flapping must not tell a customer their delivered parcel is
    // travelling again.
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", phase: "en_transito" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("ignores a regression from in transit back to accepted", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "admitido" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("still advances forwards", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "accepted", lastLocator: "PQ1", phase: "entregado" })
    );

    expect(decision).toEqual({
      notify: "received",
      persist: { lastTrackingKey: "received", lastTrackingLocator: "PQ1" },
    });
  });
});

describe("decideTrackingUpdate — problems", () => {
  it("reports a problem whatever the parcel had reached", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "in_transit", lastLocator: "PQ1", phase: "incidencia" })
    );

    expect(decision.notify).toBe("problem");
  });

  it("reports a problem only once", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "problem", lastLocator: "PQ1", phase: "incidencia" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });

  it("lets a parcel recover and reach the warehouse after a problem", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "problem", lastLocator: "PQ1", phase: "entregado" })
    );

    expect(decision.notify).toBe("received");
  });
});

describe("decideTrackingUpdate — a new locator is a new parcel", () => {
  it("starts over when the customer re-registered", () => {
    // A re-registration is a different parcel with its own Correos code. Its
    // journey legitimately begins again at accepted.
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", currentLocator: "PQ2", phase: "admitido" })
    );

    expect(decision).toEqual({
      notify: "accepted",
      persist: { lastTrackingKey: "accepted", lastTrackingLocator: "PQ2" },
    });
  });

  it("still ignores an untraceable new parcel", () => {
    const decision = decideTrackingUpdate(
      input({ lastKey: "received", lastLocator: "PQ1", currentLocator: "PQ2", phase: "sin_informacion" })
    );

    expect(decision).toEqual({ notify: null, persist: null });
  });
});
