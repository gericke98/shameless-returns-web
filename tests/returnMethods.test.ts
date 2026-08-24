import { describe, expect, it } from "vitest";
import {
  defaultMethodFor,
  resolveReturnMethod,
  selfBookingOffered,
} from "@/lib/returnMethods";

describe("defaultMethodFor", () => {
  it("routes Spain to Correos", () => {
    expect(defaultMethodFor("Spain", true)).toBe("CORREOS");
  });

  it("routes elsewhere to Amphora when the flag is on", () => {
    expect(defaultMethodFor("Italy", true)).toBe("AMPHORA");
  });

  it("falls back to Correos when the Amphora flag is off", () => {
    // Behaviour-identical to the Correos-only flow, which is what the flag
    // being off has always meant.
    expect(defaultMethodFor("Italy", false)).toBe("CORREOS");
  });
});

describe("selfBookingOffered", () => {
  it("is offered when the return leg costs the customer money", () => {
    expect(selfBookingOffered(650)).toBe(true);
  });

  it("is hidden when our own return leg is free", () => {
    // Self-booking could only cost them more, so offering it would invite
    // people to pay postage they did not need to pay.
    expect(selfBookingOffered(0)).toBe(false);
  });
});

describe("resolveReturnMethod", () => {
  it("honours a valid SELF claim when it is offered", () => {
    expect(resolveReturnMethod("SELF", "Italy", true, 650)).toBe("SELF");
  });

  it("refuses SELF where it is not offered", () => {
    // The amount is never taken from the client; neither is the right to
    // claim a lane that would reduce it.
    expect(resolveReturnMethod("SELF", "Italy", true, 0)).toBe("AMPHORA");
  });

  it("ignores an unknown method rather than trusting it", () => {
    expect(resolveReturnMethod("FREE_PLEASE", "Spain", true, 650)).toBe("CORREOS");
  });

  it("ignores a non-string claim", () => {
    expect(resolveReturnMethod(undefined, "Spain", true, 650)).toBe("CORREOS");
    expect(resolveReturnMethod({ method: "SELF" }, "Spain", true, 650)).toBe("CORREOS");
  });

  it("never lets the client pick our own lanes either", () => {
    // A Spanish order claiming AMPHORA would book a collection we do not
    // offer domestically. Only SELF is the customer's to choose.
    expect(resolveReturnMethod("AMPHORA", "Spain", true, 650)).toBe("CORREOS");
  });
});
