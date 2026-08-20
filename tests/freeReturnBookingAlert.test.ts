import { beforeEach, describe, expect, it, vi } from "vitest";

// Order #311174 (Ferran Palma), 2026-08-12 07:39:36Z. The portal created the
// Shopify return, the Correos booking then failed, and he was shown /success
// anyway. Eight days later he wrote in: "en ningún momento me ha llegado la
// etiqueta". Postmark had never sent him anything at all.
//
// Nothing was wrong with the swallowing. What was wrong is that the FREE lane
// swallowed it SILENTLY: the Stripe webhook already calls alertPaidButNoReturn
// on exactly this condition, and `d22c449` covered "label registered but the
// email failed" on both lanes — but a free return whose carrier booking never
// happened reached nobody. Its only trace was a `console.error` in logs Vercel
// keeps for about an hour.
//
// The revert cannot clean up after it either: `updateFinalOrder` refuses to
// revert a row that already carries a `return_id` (learned from #310957), so
// the row is left confirmed, with no locator, and the customer is left holding
// a parcel they cannot send.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const REDIRECTED = "NEXT_REDIRECT";

const order: Record<string, any> = {
  id: "13221047697734",
  orderNumber: "#311174",
  email: "ferranpalma@example.com",
  shippingName: "Ferran Palma",
  shippingAddress1: "Avinguda de Casalduch 56",
  shippingZip: "12005",
  shippingCity: "Castello de la Plana",
  shippingProvince: "Castellon",
  shippingCountry: "Spain",
  shippingPhone: "689168520",
  locale: "es",
  locator: null,
  products: [{ variant_id: "1", quantity: 1, action: "DEVOLUCIÓN" }],
};

/** Correos accepted, returned tracking and the label PDF. */
const CORREOS_OK =
  "<Resultado>0</Resultado><CodEnvio>PQAZXT9800005660128110S</CodEnvio><Fichero>JVBERi0xLjQK</Fichero>";

/**
 * Correos refused the shipment. It answers HTTP 200 for business errors, so
 * this is what a rejection actually looks like: no <CodEnvio>, and the reason
 * only in <DescError>.
 */
const CORREOS_REJECTED =
  "<Resultado>1</Resultado><Error>1101</Error><DescError>Codigo postal del remitente erroneo</DescError>";

const behaviour = { correos: CORREOS_OK, bookingThrows: false };
const alerts: { subject: string; body: string }[] = [];
const redirects: string[] = [];

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw Object.assign(new Error(REDIRECTED), { to });
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => ({ name: "locale", value: "es" }) }),
}));

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

// Nothing to pay: this is the free lane, the one that had no alert.
vi.mock("@/actions/payments", () => ({
  createStripeUrl: async () => ({ data: null }),
}));

vi.mock("@/actions/updateOrder", () => ({ updateFinalOrder: async () => {} }));

vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    alerts.push({ subject, body });
  },
}));

vi.mock("@/db/queries", () => ({
  getOrderById: async () => order,
  getOrderByIdFresh: async () => order,
  saveReturnLabel: async () => {},
  getLatestReturnLabel: async () => null,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: (values: Record<string, any>) => {
      Object.assign(order, values);
      return chain;
    },
    where: () => Promise.resolve(),
  };
  return { default: chain };
});

vi.mock("axios", () => ({
  default: {
    post: async (url: string) => {
      if (String(url).includes("postmarkapp.com")) return { status: 200 };
      if (behaviour.bookingThrows) throw new Error("socket hang up");
      return { status: 200, data: behaviour.correos };
    },
  },
}));

async function submit() {
  const { returnFunction } = await import("@/actions/return");
  try {
    await returnFunction(order.id, false, order.email);
  } catch (e: any) {
    if (e?.message !== REDIRECTED) throw e;
  }
}

beforeEach(() => {
  behaviour.correos = CORREOS_OK;
  behaviour.bookingThrows = false;
  alerts.length = 0;
  redirects.length = 0;
  order.locator = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
});

describe("a free return that never got a label must reach a human", () => {
  it("stays silent when the booking worked", async () => {
    await submit();

    expect(alerts).toHaveLength(0);
  });

  it("alerts when Correos refused the shipment", async () => {
    behaviour.correos = CORREOS_REJECTED;

    await submit();

    expect(alerts).toHaveLength(1);
  });

  it("alerts when the booking throws instead of returning a status", async () => {
    behaviour.bookingThrows = true;

    await submit();

    expect(alerts).toHaveLength(1);
  });

  it("gives the human the order and the customer to act on", async () => {
    behaviour.correos = CORREOS_REJECTED;

    await submit();

    const text = `${alerts[0]?.subject}\n${alerts[0]?.body}`;
    expect(text).toContain(order.orderNumber);
    expect(text).toContain(order.email);
  });

  it("says the customer was shown /success, so nobody waits for them to complain", async () => {
    // The whole reason this went eight days unseen: the customer has no idea
    // anything failed and will not necessarily write in.
    behaviour.correos = CORREOS_REJECTED;

    await submit();

    expect(`${alerts[0]?.subject}\n${alerts[0]?.body}`).toContain("/success");
  });

  it("still sends the customer to /success", async () => {
    // Deliberate, and unchanged: the Shopify return is real. Alerting is what
    // was missing, not a new failure page.
    behaviour.correos = CORREOS_REJECTED;

    await submit();

    expect(redirects).toContain("/success");
  });
});
