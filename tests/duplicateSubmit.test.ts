import { beforeEach, describe, expect, it, vi } from "vitest";

// Resubmitting booked a SECOND Correos label. Production, 2026-08-10 07:41:
// order #311148 sent FIVE "Tu devolución se ha creado correctamente" emails in
// eleven seconds, each carrying its own Return_label.pdf — five pre-registered
// parcels, five charges, one box. One Shopify return, because updateFinalOrder
// guards that; nothing guarded the label.
//
// #311201 (Belgium) shows the same shape on the international path five minutes
// apart: Amphora correctly reused the existing collection, and we emailed the
// customer about it twice anyway.
//
// These drive `returnFunction` — the server action the button calls — rather
// than the units beneath it, because "the customer pressed it twice" is the
// behaviour under test.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const REDIRECTED = "NEXT_REDIRECT";

const order: Record<string, any> = {
  id: "13217168851270",
  orderNumber: "#311148",
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

const calls = { correos: 0, postmark: 0 };

const CORREOS_OK = (code: string) =>
  `<Resultado>0</Resultado><CodEnvio>${code}</CodEnvio><Fichero>JVBERi0xLjQK</Fichero>`;

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(REDIRECTED), { to });
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => ({ name: "locale", value: "es" }) }),
}));

vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

// Nothing to pay, so returnFunction stays on the free path instead of leaving
// for Stripe.
vi.mock("@/actions/payments", () => ({
  createStripeUrl: async () => ({ data: null }),
}));

// Its own duplicate guard is already tested; here it must not be what saves us.
vi.mock("@/actions/updateOrder", () => ({ updateFinalOrder: async () => {} }));

vi.mock("@/db/queries", () => ({
  getOrderById: async () => order,
  getOrderByIdFresh: async () => order,
  saveReturnLabel: async () => {},
  getLatestReturnLabel: async () => null,
}));

// Persist what the code writes, so the second submit sees the first one's work.
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
      if (String(url).includes("postmarkapp.com")) {
        calls.postmark += 1;
        return { status: 200 };
      }
      calls.correos += 1;
      // A fresh code every time, exactly like Correos: two registrations are
      // two different parcels, which is what makes this expensive.
      return { status: 200, data: CORREOS_OK(`PQ00000000${calls.correos}ES`) };
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
  calls.correos = 0;
  calls.postmark = 0;
  order.locator = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  // Not under test here, and it would reach for Amphora. Its own behaviour is
  // pinned in tests/domesticPreregistration.test.ts.
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
  process.env.AMPHORA_INTL_RETURNS_ENABLED = "false";
});

describe("a customer who submits the same return twice", () => {
  it("registers exactly one Correos label", async () => {
    await submit();
    await submit();

    expect(calls.correos).toBe(1);
  });

  it("is emailed once, not once per attempt", async () => {
    await submit();
    await submit();

    expect(calls.postmark).toBe(1);
  });

  it("keeps the tracking from the label that was actually registered", async () => {
    await submit();
    const first = order.locator;
    await submit();

    expect(order.locator).toBe(first);
  });

  it("still registers and emails on a first, genuine submit", async () => {
    await submit();

    expect(calls.correos).toBe(1);
    expect(calls.postmark).toBe(1);
    expect(order.locator).toBeTruthy();
  });

  it("registers five times for five submits only if the guard is gone", async () => {
    // The production incident, replayed: five sequential submits, three seconds
    // apart in reality. One parcel must mean one label.
    for (let i = 0; i < 5; i++) await submit();

    expect(calls.correos).toBe(1);
    expect(calls.postmark).toBe(1);
  });
});
