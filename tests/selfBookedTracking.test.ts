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
const written: any[] = [];
let access = true;
// Simulates a competitor submit winning the conditional UPDATE between our
// read and our write — the write-once race the atomic guard exists to stop.
let raceLoser = false;

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => access }));

vi.mock("@/db/queries", () => ({
  getOrderByIdFresh: async () => order,
  getOrderById: async () => order,
}));

vi.mock("@/actions/amphora", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    approveAmphoraReturn: async (id: string, data: any) => {
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

async function submit(carrier = "DHL", number = "JD0123456789") {
  const { submitReturnTracking } = await import("@/actions/selfBookedTracking");
  return submitReturnTracking(order.id, carrier, number);
}

beforeEach(() => {
  approved.length = 0;
  written.length = 0;
  access = true;
  raceLoser = false;
  order.locator = null;
  order.carrier = null;
  order.returnMethod = "SELF";
});

describe("submitReturnTracking", () => {
  it("stores the carrier and tracking number", async () => {
    await expect(submit()).resolves.toEqual({ ok: true });

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

  it("approves Amphora with the customer's carrier data", async () => {
    await submit();

    expect(approved).toHaveLength(1);
    expect(approved[0].data).toEqual({
      carrier: "DHL",
      carrier_number: "JD0123456789",
      carrier_url: expect.stringContaining("JD0123456789"),
    });
  });

  it("refuses a second submit rather than re-approving", async () => {
    // carrier_number is pinned at the first approve. A second attempt 422s and
    // cancel+recreate hands back the OLD number, desyncing the warehouse
    // forever, so this must stop before it reaches Amphora.
    await submit();
    approved.length = 0;

    const second = await submit("UPS", "1Z999");

    expect(second.ok).toBe(false);
    expect(approved).toHaveLength(0);
    expect(order.locator).toBe("JD0123456789");
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

    const result = await submit();

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

    expect(result.ok).toBe(false);
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
