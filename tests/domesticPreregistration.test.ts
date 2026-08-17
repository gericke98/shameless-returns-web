import { beforeEach, describe, expect, it, vi } from "vitest";

// Spanish returns travel on OUR Correos label, but Amphora is the warehouse
// that receives the box. Until now they learned about a domestic return only
// when it turned up, so nothing was expected and nothing could be reconciled.
//
// Registering it as an EXTERNAL return fixes that: Amphora records the return
// and the tracking, and arranges no transport of its own.
//
// The mechanism is prescribed by their OpenAPI (company-api.yaml):
//   POST /returns              → only `return_order` and `auto_approve`.
//                                `carrier_data` is NOT part of this schema; sent
//                                here it is accepted and silently ignored.
//   PATCH /returns/{id}/approve → takes `carrier_data` {carrier, carrier_number,
//                                carrier_url}, "to be used for the external
//                                return".
//
// Omitting `auto_approve` is what makes this safe: the return sits at PENDING
// with no warehouse and no carrier, so auto-assign cannot book a courier
// against a parcel the customer is dropping at a Correos office. Approval and
// the external carrier arrive together, in one call.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const calls: { created: any[]; approved: any[] } = { created: [], approved: [] };
const behaviour = { createFails: false, approveFails: false };

const ORDER: Record<string, any> = {
  id: "12733447799110",
  orderNumber: "#38594",
  email: "customer@example.com",
  shippingName: "Ana Ruiz Garcia",
  shippingAddress1: "Calle Mayor 12",
  shippingZip: "28001",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "Spain",
  shippingPhone: "600000000",
  locale: "es",
  locator: null,
  products: [
    { variant_id: "1", quantity: 1, action: "DEVOLUCIÓN", confirmed: true },
  ],
};

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  getVariantSkusByIds: async () => ({ "1": "SKU-1" }),
  // Label storage is not what this file pins; its own behaviour lives in
  // tests/returnLabelStorage.test.ts.
  saveReturnLabel: async () => {},
  getLatestReturnLabel: async () => null,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      Object.assign(ORDER, values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("@/actions/amphora", () => ({
  amphoraOrderIdFromShopifyId: (id: string) => `SHP ${id}`,
  createAmphoraReturn: async (input: any) => {
    if (behaviour.createFails) throw new Error("amphora 500");
    calls.created.push(input);
    // Amphora returns the return id, which is the order id — verified on a live
    // probe: POST /returns for order "MNL 178407654654241536" came back with
    // `id: "MNL 178407654654241536"`.
    return { id: input.orderId, internal_status: "PENDING" };
  },
  approveAmphoraReturn: async (returnId: string, carrierData: any) => {
    if (behaviour.approveFails) throw new Error("amphora approve 500");
    calls.approved.push({ returnId, carrierData });
    return { id: returnId, internal_status: "APROVED" };
  },
  getAmphoraReturnsByOrderName: async () => [],
}));

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) return { status: 200 };
      return {
        status: 200,
        data: "<Resultado>0</Resultado><CodEnvio>PQ123456789ES</CodEnvio><Fichero>JVBERi0=</Fichero>",
      };
    },
  },
}));

async function registerLabel() {
  const { createShippingLabel } = await import("@/actions/shipping");
  return createShippingLabel(ORDER.id);
}

beforeEach(() => {
  calls.created = [];
  calls.approved = [];
  behaviour.createFails = false;
  behaviour.approveFails = false;
  ORDER.locator = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  delete process.env.AMPHORA_DOMESTIC_PREREGISTER;
});

describe("registering a Spanish return with Amphora", () => {
  it("creates the return against the order", async () => {
    await registerLabel();

    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].orderId).toBe("SHP 12733447799110");
    expect(calls.created[0].externalId).toBe("12733447799110");
  });

  it("never asks Amphora to auto-approve it", async () => {
    // The whole safety argument. auto_approve would let auto-assign book a
    // courier for a parcel that is going by Correos.
    await registerLabel();

    expect(calls.created[0].autoApprove).toBeFalsy();
  });

  it("approves it as an EXTERNAL return carrying our Correos tracking", async () => {
    await registerLabel();

    expect(calls.approved).toHaveLength(1);
    expect(calls.approved[0].carrierData).toEqual({
      carrier: "CORREOS",
      carrier_number: "PQ123456789ES",
      carrier_url: expect.stringContaining("PQ123456789ES"),
    });
  });

  it("approves the return Amphora actually created", async () => {
    await registerLabel();

    expect(calls.approved[0].returnId).toBe("SHP 12733447799110");
  });

  it("still reports success to the customer when Amphora is down", async () => {
    // The Correos label is registered and the customer has been emailed. A
    // warehouse pre-registration failing is an ops problem, never the
    // customer's — and reverting here would discard a live return.
    behaviour.createFails = true;

    await expect(registerLabel()).resolves.toBe(200);
  });

  it("still reports success when the approve call fails", async () => {
    behaviour.approveFails = true;

    await expect(registerLabel()).resolves.toBe(200);
    expect(calls.created).toHaveLength(1);
  });

  it("registers nothing when Correos never issued a label", async () => {
    // Nothing to tell the warehouse about, and no tracking for carrier_data.
    ORDER.locator = "PQALREADYTHERE";

    await registerLabel();

    expect(calls.created).toHaveLength(0);
  });

  it("can be switched off without a deploy", async () => {
    process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";

    await registerLabel();

    expect(calls.created).toHaveLength(0);
  });
});
