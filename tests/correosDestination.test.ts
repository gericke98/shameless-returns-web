import { beforeEach, describe, expect, it, vi } from "vitest";

// Where a domestic return parcel is actually sent. The destination block in the
// Correos pre-registration was still the old warehouse (CORISA TEXTIL,
// Majadahonda 28221) long after the 3PL became Amphora, so every label printed
// sent the customer's parcel to an address that no longer receives returns.
//
// Hardcoded on purpose — it is the one address every domestic return goes to —
// which is exactly why it needs a test: nothing else would notice it drifting.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
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
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

let soapBody = "";

vi.mock("@/db/queries", () => ({ getOrderById: async () => ORDER }));

vi.mock("@/db/drizzle", () => {
  const chain: any = { update: () => chain, set: () => chain, where: () => Promise.resolve() };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (url: string, body: any) => {
      if (String(url).includes("postmarkapp.com")) return { status: 200 };
      soapBody = String(body);
      return {
        status: 200,
        data: "<Resultado>0</Resultado><CodEnvio>PQ1ES</CodEnvio><Fichero>JVBERi0=</Fichero>",
      };
    },
  },
}));

async function registerLabel() {
  const { createShippingLabel } = await import("@/actions/shipping");
  return createShippingLabel(ORDER.id);
}

beforeEach(() => {
  soapBody = "";
  ORDER.locator = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  // Not under test here, and it would reach for Amphora. Its own behaviour is
  // pinned in tests/domesticPreregistration.test.ts.
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
});

describe("the Correos label destination", () => {
  it("sends the parcel to Amphora in Algete", async () => {
    await registerLabel();

    expect(soapBody).toContain("Calle Pelaya");
    expect(soapBody).toContain("28110");
    expect(soapBody).toContain("Algete");
  });

  it("no longer sends anything to the old Majadahonda warehouse", async () => {
    await registerLabel();

    expect(soapBody).not.toContain("Majadahonda");
    expect(soapBody).not.toContain("CORISA");
    expect(soapBody).not.toContain("28221");
    expect(soapBody).not.toContain("Costa Rica");
  });

  it("carries the warehouse contact number, for the delivery call and the SMS", async () => {
    await registerLabel();

    // Correos uses it twice: Telefonocontacto and DatosSMS/NumeroSMS.
    const occurrences = soapBody.split("644371629").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(soapBody).not.toContain("604141762");
  });

  it("still sends FROM the customer, not from the warehouse", async () => {
    // The sender block is the customer returning the parcel; only the
    // destination changed.
    await registerLabel();

    expect(soapBody).toContain("Calle Mayor 12");
    expect(soapBody).toContain("28001");
  });
});
