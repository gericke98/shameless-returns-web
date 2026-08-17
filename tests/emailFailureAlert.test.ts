import { beforeEach, describe, expect, it, vi } from "vitest";

// Six customers, three days, zero emails, and not one signal.
//
// From 2026-08-14 13:29Z every return the portal created produced no customer
// email at all — on BOTH lanes. Returns, labels, collections and stock holds
// were all created correctly; only the notification was missing. Nothing
// alerted, because both `createShippingLabel` and `createInternationalReturn`
// deliberately swallow every post-registration failure (a revert cannot
// un-register a Correos label) and answer 200. The Stripe webhook then sees a
// healthy 200 and schedules no retry.
//
// The only trace was a `console.error` in logs Vercel keeps for about an hour.
// It surfaced when a customer wrote in on day three.
//
// So: the swallowing stays — it is correct — but it must never again be
// SILENT. Every "the parcel exists but the customer was not told" branch has
// to reach a human, carrying what they need to act.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const ORDER = {
  id: "13225675260230",
  orderNumber: "#311199",
  email: "customer@example.com",
  shippingName: "Adria Costa Perez",
  shippingAddress1: "Carrer del Tiller 12",
  shippingZip: "07011",
  shippingCity: "Palma",
  shippingProvince: "Balears",
  shippingCountry: "Spain",
  shippingPhone: "600000000",
  locale: "es",
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

const TRACKING = "PQAZXT9800005460128110J";

/** Correos accepted the shipment AND returned the label PDF. */
const CORREOS_OK = `<Resultado>0</Resultado><CodEnvio>${TRACKING}</CodEnvio><Fichero>JVBERi0xLjQK</Fichero>`;

/**
 * Correos accepted the shipment and returned tracking, but NO <Fichero>.
 *
 * `sendShippingLabel` validates <Resultado> and <CodEnvio> only, so this reads
 * as a complete success: the parcel is registered, the locator is stored, and
 * `sendEmail` then bails on the missing PDF and returns 500 into a branch that
 * only logged. The customer is left with a live return and no label.
 */
const CORREOS_NO_PDF = `<Resultado>0</Resultado><CodEnvio>${TRACKING}</CodEnvio>`;

const behaviour = { correos: CORREOS_OK, emailFails: false };
const alerts: { subject: string; body: string }[] = [];

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  saveReturnLabel: async () => {},
  getLatestReturnLabel: async () => null,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

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
  alerts.length = 0;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
});

describe("a label without a customer email must reach a human", () => {
  it("stays silent when the customer was actually emailed", async () => {
    await expect(run()).resolves.toBe(200);

    expect(alerts).toHaveLength(0);
  });

  it("alerts when Postmark refused the confirmation", async () => {
    behaviour.emailFails = true;

    await expect(run()).resolves.toBe(200);

    expect(alerts).toHaveLength(1);
  });

  it("alerts when Correos returned tracking but no label PDF", async () => {
    // The exact shape of the outage: everything reports success and the
    // customer gets nothing.
    behaviour.correos = CORREOS_NO_PDF;

    await expect(run()).resolves.toBe(200);

    expect(alerts).toHaveLength(1);
  });

  it("gives the human the order, the customer and the tracking to act on", async () => {
    behaviour.emailFails = true;

    await run();

    const text = `${alerts[0]?.subject}\n${alerts[0]?.body}`;
    expect(text).toContain(ORDER.orderNumber);
    expect(text).toContain(ORDER.email);
    // Without this they cannot tell the customer anything, nor find the parcel.
    expect(text).toContain(TRACKING);
  });

  it("names the missing PDF as the reason, not a generic email failure", async () => {
    // "Postmark is down" and "Correos sent no label" need different responses
    // from whoever picks the alert up, so the alert has to tell them apart.
    behaviour.correos = CORREOS_NO_PDF;

    await run();

    expect(`${alerts[0]?.subject}\n${alerts[0]?.body}`.toLowerCase()).toContain("pdf");
  });
});
