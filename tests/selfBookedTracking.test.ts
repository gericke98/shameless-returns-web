import { beforeEach, describe, expect, it, vi } from "vitest";

// The capture half. Two guards carry the weight here:
//
// 1. carrier_number is WRITE-ONCE at Amphora approve. Re-approving 422s and
//    cancel+recreate returns the OLD number, so a second submit must never
//    reach approve.
// 2. `carrier` must never be null on a row that has a locator:
//    tracksWithCorreos(null) === true means "our own Correos label", so a null
//    carrier would send a DHL number to localizador.correos.es.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const order: Record<string, any> = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "customer@example.com",
  returnMethod: "SELF",
  locator: null,
  carrier: null,
};

const approved: any[] = [];
// When set, Amphora refuses the approve with this axios-shaped error.
let approveError: any = null;
const alerts: { subject: string; body: string }[] = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));
const written: any[] = [];
let access = true;
// Simulates a competitor submit winning the conditional UPDATE between our
// read and our write — the write-once race the atomic guard exists to stop.
let raceLoser = false;

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => access }));

// What the carrier says about the number (lib/carrierLookup is the network).
let verdict: "verified" | "unknown" | "unreadable" = "verified";
const lookedUp: { verifier: string; number: string }[] = [];
vi.mock("@/lib/carrierLookup", () => ({
  verifyWithCarrier: async (verifier: string, number: string) => {
    lookedUp.push({ verifier, number });
    return verdict;
  },
}));

vi.mock("@/db/queries", () => ({
  getOrderByIdFresh: async () => order,
  getOrderById: async () => order,
}));

vi.mock("@/actions/amphora", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    approveAmphoraReturn: async (id: string, data: any) => {
      if (approveError) throw approveError;
      approved.push({ id, data });
      return { id, internal_status: "APROVED" };
    },
  };
});

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      written.push(values);
      chain._pending = values;
      return chain;
    },
    where: () => chain,
    // The real code awaits `.returning(...)`, not `.where(...)`, so the
    // conditional UPDATE's outcome — did our write actually land, or did a
    // competitor already claim the row — has to be decided here.
    returning: async () => {
      if (raceLoser) return [];
      Object.assign(order, chain._pending);
      return [{ id: order.id }];
    },
  };
  return { default: chain };
});

async function submit(carrier = "DHL", number = "JD0123456789", url?: unknown) {
  const { submitReturnTracking } = await import("@/actions/selfBookedTracking");
  return submitReturnTracking(order.id, carrier, number, url);
}

beforeEach(() => {
  approved.length = 0;
  written.length = 0;
  access = true;
  raceLoser = false;
  approveError = null;
  alerts.length = 0;
  verdict = "verified";
  lookedUp.length = 0;
  order.locator = null;
  order.carrier = null;
  order.returnMethod = "SELF";
});

describe("submitReturnTracking", () => {
  it("stores the carrier and tracking number", async () => {
    await expect(submit()).resolves.toEqual({ ok: true, pending: true });

    expect(order.locator).toBe("JD0123456789");
    expect(order.carrier).toBe("DHL");
  });

  it("never leaves the carrier null once a locator exists", async () => {
    await submit();

    expect(order.locator).not.toBeNull();
    expect(order.carrier).not.toBeNull();
  });

  it("stores a tracking URL the customer can actually open", async () => {
    await submit();

    expect(String(order.carrierUrl)).toContain("JD0123456789");
  });

  it("approves Amphora with a number the carrier verified", async () => {
    await expect(submit("CORREOS", "PQ0B7K0000043680128110B")).resolves.toEqual({ ok: true });

    expect(lookedUp).toEqual([{ verifier: "correos", number: "PQ0B7K0000043680128110B" }]);
    expect(approved).toHaveLength(1);
    expect(approved[0].data).toEqual({
      carrier: "CORREOS",
      carrier_number: "PQ0B7K0000043680128110B",
      carrier_url: expect.stringContaining("PQ0B7K0000043680128110B"),
    });
    expect(order.trackingVerifiedBy).toBe("correos");
    expect(order.trackingVerifiedAt).toBeInstanceOf(Date);
  });

  it("refuses a second submit rather than re-approving", async () => {
    // carrier_number is pinned at the first approve. A second attempt 422s and
    // cancel+recreate hands back the OLD number, desyncing the warehouse
    // forever, so this must stop before it reaches Amphora.
    await submit("CORREOS", "PQ0B7K0000043680128110B");
    approved.length = 0;

    const second = await submit("UPS", "1Z999");

    expect(second.ok).toBe(false);
    expect(approved).toHaveLength(0);
    expect(order.locator).toBe("PQ0B7K0000043680128110B");
  });

  it("refuses tracking when a concurrent submit wins the write-once race", async () => {
    // The sequential check above (`order.locator`) is only a fast-path
    // rejection — it is check-then-act, so two near-simultaneous submits (a
    // double-click that beats the disabled button, a retried POST, two open
    // tabs) can both pass it before either write lands. The database is what
    // actually arbitrates: the conditional UPDATE's WHERE clause matches only
    // a row that STILL has no locator, so the loser's UPDATE affects zero
    // rows. That loser must stop here, before Amphora — its carrier_number
    // pin cannot be undone, so only the write's real winner may call approve.
    raceLoser = true;

    const result = await submit("CORREOS", "PQ0B7K0000043680128110B");

    expect(result).toEqual({ ok: false, reason: "already-submitted" });
    expect(approved).toHaveLength(0);
  });

  it("rejects a caller with no portal session", async () => {
    access = false;

    const result = await submit();

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("rejects an unknown carrier rather than storing free text", async () => {
    const result = await submit("Correos de mi primo", "X1");

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("rejects an empty tracking number", async () => {
    const result = await submit("DHL", "   ");

    expect(result.ok).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("rejects a non-string tracking number rather than coercing it", async () => {
    // A server action is an addressable endpoint: the form protects the button,
    // not this function. `String(x)` would turn an object into
    // "[object Object]" and an array into its joined elements, and pin THAT at
    // Amphora write-once — where it cannot be corrected.
    // Called directly, not through `submit`: that helper has a default
    // argument, so passing `undefined` through it would silently substitute a
    // valid tracking number and the case would pass for the wrong reason.
    const { submitReturnTracking } = await import("@/actions/selfBookedTracking");
    for (const junk of [{ toString: () => "1Z999" }, ["1Z999"], 1234, null, undefined]) {
      const result = await submitReturnTracking(
        order.id,
        "DHL",
        junk as unknown as string
      );

      expect(result).toEqual({ ok: false, reason: "empty-tracking" });
    }
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });

  it("rejects an absurdly long tracking number", async () => {
    // The column is unbounded `text` and Amphora pins the value write-once, so
    // there is no correcting it afterwards. The longest real carrier reference
    // is around 35 characters.
    const result = await submit("DHL", "1Z".repeat(200));

    expect(result).toEqual({ ok: false, reason: "too-long" });
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });

  it("still accepts a tracking number at the long end of what carriers issue", async () => {
    // The control half: the bound must not reject a real reference. Correos
    // certificate numbers are 23 characters.
    const result = await submit("CORREOS", "PQAZXT9800004100128221Y");

    expect(result).toEqual({ ok: true });
    expect(order.locator).toBe("PQAZXT9800004100128221Y");
  });

  it("refuses an order that is not a self-booked return", async () => {
    order.returnMethod = "CORREOS";

    const result = await submit();

    expect(result.ok).toBe(false);
    expect(approved).toHaveLength(0);
  });

});

// #312783 / #312737 (2026-11-23): "Other" sent `carrier_url: ""`, a field
// Amphora's approve requires, and the approvals failed. The link is pinned
// write-once with the number, so it is checked before anything is written.
describe("submitReturnTracking — a carrier whose link the customer gives", () => {
  const LINK = "https://www.cttexpresso.pt/track?ref=7280-13972666";

  it("refuses 'Other' with no link, writing nothing and telling Amphora nothing", async () => {
    await expect(submit("OTHER", "7280/13972666")).resolves.toEqual({ ok: false, reason: "missing-url" });
    await expect(submit("OTHER", "7280/13972666", "   ")).resolves.toEqual({ ok: false, reason: "missing-url" });
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
    expect(order.locator).toBeNull();
  });

  it.each([
    ["not a URL", "my parcel"],
    ["no host", "https://"],
    ["a script", "javascript:alert(1)"],
    ["a data URL", "data:text/html,hi"],
    ["far too long", `https://example.com/${"a".repeat(600)}`],
    ["not a string", { href: "https://example.com" }],
  ])("refuses 'Other' with %s, writing nothing", async (_label, url) => {
    await expect(submit("OTHER", "7280/13972666", url)).resolves.toEqual({ ok: false, reason: "invalid-url" });
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });

  it("stores the customer's link for 'Other' and gives it to ops", async () => {
    await expect(submit("OTHER", "7280/13972666", `  ${LINK}  `)).resolves.toEqual({ ok: true, pending: true });
    expect(order.carrierUrl).toBe(LINK);
    expect(alerts[0].body).toContain(LINK);
  });

  // Amphora's carrier_url is a plain string: any http(s) link a browser can
  // open is the carrier's to choose, including an IP host (Codex review).
  it("accepts any http(s) link, whatever its host looks like", async () => {
    await expect(submit("OTHER", "7280/13972666", "http://10.0.0.1/track?id=7280")).resolves.toEqual({ ok: true, pending: true });
    expect(order.carrierUrl).toBe("http://10.0.0.1/track?id=7280");
  });

  it("ignores a client link for a carrier whose link we build", async () => {
    await submit("DHL", "JD0123456789", "https://evil.example.com/x");
    expect(order.carrierUrl).toContain("dhl.com");
  });
});

describe("submitReturnTracking — when Amphora refuses", () => {
  it("puts Amphora's actual answer in the alert, not [object Object]", async () => {
    approveError = Object.assign(new Error("Request failed with status code 422"), {
      response: { status: 422, data: { message: "carrier_url is required" } },
    });

    await expect(submit("CORREOS", "PQ0B7K0000043680128110B")).resolves.toEqual({ ok: true });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).not.toContain("[object Object]");
    expect(alerts[0].body).toContain('HTTP 422: {"message":"carrier_url is required"}');
  });
});

describe("submitReturnTracking — numbers that cannot be pinned", () => {
  it.each(["#311174", "311174", "311 174", order.id])(
    "refuses the order's own reference (%s), writing nothing and telling Amphora nothing",
    async (typed) => {
      await expect(submit("CORREOS", typed)).resolves.toEqual({ ok: false, reason: "order-number" });
      expect(written).toHaveLength(0);
      expect(approved).toHaveLength(0);
    }
  );

  it("refuses a NACEX number its link cannot be built from", async () => {
    await expect(submit("NACEX", "13972666")).resolves.toEqual({ ok: false, reason: "wrong-format" });
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
  });

  it("pins a NACEX number NACEX verified, with its NACEX tracking page", async () => {
    await expect(submit("NACEX", "7280/13972666")).resolves.toEqual({ ok: true });
    expect(approved[0].data).toEqual({
      carrier: "NACEX",
      carrier_number: "7280/13972666",
      carrier_url:
        "https://www.nacex.es/seguimientoDetalle.do?agencia_origen=7280&numero_albaran=13972666&externo=N",
    });
  });
});

// docs/superpowers/plans/2026-11-24-verify-tracking-before-pin.md: a number
// reaches Amphora (write-once) only once it is verified.
describe("submitReturnTracking — verified before it is pinned", () => {
  it("refuses a number the carrier says it does not know, writing nothing and telling Amphora nothing", async () => {
    verdict = "unknown";

    await expect(submit("CORREOS", "PQ0000000000000000000XX")).resolves.toEqual({
      ok: false,
      reason: "not-at-carrier",
    });
    expect(written).toHaveLength(0);
    expect(approved).toHaveLength(0);
    expect(order.locator).toBeNull();
  });

  it.each([
    ["a carrier we cannot ask", "DHL", "JD0123456789", "cannot be checked"],
    ["a carrier that did not answer", "CORREOS", "PQ0B7K0000043680128110B", "did not answer"],
  ])("saves %s for ops, unverified, and does NOT approve", async (_l, carrier, number, why) => {
    verdict = "unreadable";

    await expect(submit(carrier, number)).resolves.toEqual({ ok: true, pending: true });
    expect(order.locator).toBe(number);
    expect(order.trackingVerifiedAt).toBeNull();
    expect(order.trackingVerifiedBy).toBeNull();
    expect(approved).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain("SELF TRACKING TO CONFIRM");
    expect(alerts[0].body).toContain(number);
    expect(alerts[0].body).toContain(why);
  });

  it("does not ask a carrier that has no check", async () => {
    await submit("DHL", "JD0123456789");
    expect(lookedUp).toHaveLength(0);
  });

  it("does not ask the carrier about a number already refused for its shape", async () => {
    await submit("CORREOS", "#311174");
    expect(lookedUp).toHaveLength(0);
  });
});
