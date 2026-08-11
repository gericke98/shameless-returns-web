import { beforeEach, describe, expect, it, vi } from "vitest";

// The same defect as the Amphora path, on the flow that carries most of the
// volume. `createShippingLabel` returned the EMAIL's status as its own, so a
// Postmark outage reported failure for a return whose Correos label had already
// been registered and whose tracking was already persisted. Both callers revert
// the database on non-200, which cannot un-register the label — it just hides a
// live return from the dashboard and tells the customer nothing.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13141322432838",
  orderNumber: "#310999",
  email: "customer@example.com",
  shippingName: "Ana Ruiz Garcia",
  shippingAddress1: "Calle Mayor 12",
  shippingZip: "28001",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "Spain",
  shippingPhone: "600000000",
  locale: "es",
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

const CORREOS_OK = `<Resultado>0</Resultado><CodEnvio>PQ123456789ES</CodEnvio><Fichero>JVBERi0xLjQK</Fichero>`;
const CORREOS_REJECTED = `<Resultado>1</Resultado><Error>1234</Error><DescError>Invalid postcode</DescError>`;

const behaviour = { correos: CORREOS_OK, emailFails: false };

vi.mock("@/db/queries", () => ({ getOrderById: async () => ORDER }));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) {
        if (behaviour.emailFails) throw new Error("postmark 503");
        return { status: 200 };
      }
      return { status: 200, data: behaviour.correos };
    },
  },
}));

async function run() {
  const { createShippingLabel } = await import("@/actions/shipping");
  return createShippingLabel(ORDER.id);
}

beforeEach(() => {
  behaviour.correos = CORREOS_OK;
  behaviour.emailFails = false;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  // Not under test here, and it would reach for Amphora. Its own behaviour is
  // pinned in tests/domesticPreregistration.test.ts.
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
});

describe("createShippingLabel — never revert a registered label", () => {
  it("succeeds on the happy path", async () => {
    await expect(run()).resolves.toBe(200);
  });

  it("still succeeds when the label was registered but the email failed", async () => {
    behaviour.emailFails = true;

    // The parcel label exists at Correos and the tracking is already stored.
    // Reporting failure here reverts a live return.
    await expect(run()).resolves.toBe(200);
  });

  it("reports failure when Correos rejected the shipment", async () => {
    // Nothing was registered, so the caller's revert is correct here.
    behaviour.correos = CORREOS_REJECTED;

    await expect(run()).resolves.not.toBe(200);
  });
});
