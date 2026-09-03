import { beforeEach, describe, expect, it, vi } from "vitest";

// `updateData` is the server action behind the portal's address form — the
// most consequential customer-facing write in the app, since it redirects
// where the return label (and now the replacement garment) is sent.
//
// These tests pin its write behaviour for the delivery_* block:
//  - an absent block CLEARS all seven columns to null, rather than omitting
//    them from the payload (which would leave a previously stored address in
//    place);
//  - a complete block writes the parsed values, with the country normalised
//    to its ISO-2 code;
//  - a partial or unsupported-country block rejects the WHOLE submission —
//    `db.update` must never be called, and `updateData` must return
//    `prevState` unchanged;
//  - `shippingCountry` is never part of the payload, in any path.

// `actions/updateOrder.ts` imports `db/queries.ts`, which wraps reads in
// React's `cache()`. That export only exists under Next's "react-server"
// condition, so plain vitest resolves a React build without it. Stub it as a
// pass-through — same shim `tests/anularOrder.test.ts` uses, for the same
// reason.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  // db/fees.ts wraps its reader in unstable_cache at module scope.
  unstable_cache: (fn: unknown) => fn,
}));

const access = { granted: true };
vi.mock("@/lib/orderAccess", () => ({
  hasOrderAccess: async () => access.granted,
}));

const updates: Record<string, unknown>[] = [];

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

const PREV_STATE = 7;

/** A base form covering the required shipping-address fields, plus whatever
 *  delivery_* overrides the test supplies. */
function buildFormData(delivery: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "5678901234");
  fd.set("name", "Ana Ruiz Garcia");
  fd.set("address", "Calle Mayor 12");
  fd.set("address2", "");
  fd.set("zip", "28001");
  fd.set("city", "Madrid");
  fd.set("province", "Madrid");
  fd.set("phone", "600000000");
  for (const [key, value] of Object.entries(delivery)) {
    fd.set(key, value);
  }
  return fd;
}

const COMPLETE_DELIVERY = {
  deliveryName: "Ana Ruiz",
  deliveryAddress1: "120 Broadway",
  deliveryAddress2: "Apt 4",
  deliveryZip: "10271",
  deliveryCity: "New York",
  deliveryProvince: "NY",
  deliveryCountry: "Estados Unidos",
};

describe("updateData — delivery address write behaviour", () => {
  beforeEach(() => {
    updates.length = 0;
    access.granted = true;
  });

  it("clears all seven delivery columns to null when no delivery block is submitted", async () => {
    const { updateData } = await import("@/actions/updateOrder");
    const result = await updateData(PREV_STATE, buildFormData());

    expect(updates).toHaveLength(1);
    const values = updates[0];

    // Assert on the actual keys present, not just their values: "omitted from
    // the payload" and "set to null" both read as absent if you only check
    // the value, and only the latter actually clears a previously stored
    // address.
    expect(values).toMatchObject({
      deliveryName: null,
      deliveryAddress1: null,
      deliveryAddress2: null,
      deliveryZip: null,
      deliveryCity: null,
      deliveryProvince: null,
      deliveryCountry: null,
    });
    for (const key of [
      "deliveryName",
      "deliveryAddress1",
      "deliveryAddress2",
      "deliveryZip",
      "deliveryCity",
      "deliveryProvince",
      "deliveryCountry",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(values, key)).toBe(true);
    }

    expect(result).toBe(PREV_STATE + 1);
  });

  it("writes a complete delivery block, normalising the country to its ISO-2 code", async () => {
    const { updateData } = await import("@/actions/updateOrder");
    const result = await updateData(PREV_STATE, buildFormData(COMPLETE_DELIVERY));

    expect(updates).toHaveLength(1);
    const values = updates[0];

    expect(values).toMatchObject({
      deliveryName: "Ana Ruiz",
      deliveryAddress1: "120 Broadway",
      deliveryAddress2: "Apt 4",
      deliveryZip: "10271",
      deliveryCity: "New York",
      deliveryProvince: "NY",
      deliveryCountry: "US",
    });

    expect(result).toBe(PREV_STATE + 1);
  });

  it("rejects a partial delivery block: db.update is never called, and prevState is returned unchanged", async () => {
    const { deliveryCity, ...partial } = COMPLETE_DELIVERY;
    const { updateData } = await import("@/actions/updateOrder");
    const result = await updateData(PREV_STATE, buildFormData(partial));

    expect(updates).toHaveLength(0);
    expect(result).toBe(PREV_STATE);
  });

  it("rejects a delivery country outside SUPPORTED_COUNTRIES: db.update is never called, and prevState is returned unchanged", async () => {
    const { updateData } = await import("@/actions/updateOrder");
    const result = await updateData(
      PREV_STATE,
      buildFormData({ ...COMPLETE_DELIVERY, deliveryCountry: "Freedonia" })
    );

    expect(updates).toHaveLength(0);
    expect(result).toBe(PREV_STATE);
  });

  it("never writes shippingCountry, on the clearing path or the complete path", async () => {
    const { updateData } = await import("@/actions/updateOrder");

    await updateData(PREV_STATE, buildFormData());
    await updateData(PREV_STATE, buildFormData(COMPLETE_DELIVERY));

    expect(updates).toHaveLength(2);
    for (const values of updates) {
      expect(Object.prototype.hasOwnProperty.call(values, "shippingCountry")).toBe(
        false
      );
    }
  });
});
