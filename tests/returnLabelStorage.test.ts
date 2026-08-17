import { beforeEach, describe, expect, it, vi } from "vitest";

// Correos hands the label PDF over exactly once, in the <Fichero> of the
// PreRegistro response, and there is no way to ask for it again. We used to
// keep only the tracking string, so "re-send the label" meant registering a
// SECOND physical parcel — uncancellable, separately charged, and it desyncs
// the warehouse, because an Amphora EXTERNAL return pins its carrier_number at
// approval and refuses a new one.
//
// The August 2026 outage made that concrete: five real Correos registrations
// for two customers, and both now hold a tracking number Algete is not
// expecting. Storing the PDF makes a re-send free.

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
const PDF = "JVBERi0xLjQK";

const CORREOS_OK = `<Resultado>0</Resultado><CodEnvio>${TRACKING}</CodEnvio><Fichero>${PDF}</Fichero>`;
// Registered, tracking issued, no label. `sendShippingLabel` reports success.
const CORREOS_NO_PDF = `<Resultado>0</Resultado><CodEnvio>${TRACKING}</CodEnvio>`;
const CORREOS_REJECTED = `<Resultado>1</Resultado><DescError>Invalid postcode</DescError>`;

const behaviour = { correos: CORREOS_OK, emailFails: false };
const saved: { orderId: string; trackingNumber: string; pdfBase64: string }[] = [];
const posted: any[] = [];
let storedLabel: any = null;

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  saveReturnLabel: async (orderId: string, trackingNumber: string, pdfBase64: string) => {
    saved.push({ orderId, trackingNumber, pdfBase64 });
  },
  getLatestReturnLabel: async () => storedLabel,
}));

vi.mock("@/db/drizzle", () => {
  const chain: any = { update: () => chain, set: () => chain, where: () => Promise.resolve() };
  return { default: chain };
});

vi.mock("@/actions/opsAlert", () => ({ alertOps: async () => {} }));

vi.mock("axios", () => ({
  default: {
    post: async (url: string, body: any) => {
      if (String(url).includes("postmarkapp.com")) {
        posted.push(body);
        if (behaviour.emailFails) throw new Error("postmark 503");
        return { status: 200 };
      }
      return { status: 200, data: behaviour.correos };
    },
  },
}));

const load = () => import("@/actions/shipping");

beforeEach(() => {
  behaviour.correos = CORREOS_OK;
  behaviour.emailFails = false;
  saved.length = 0;
  posted.length = 0;
  storedLabel = null;
  process.env.POSTMARK_SERVER_TOKEN = "test-token";
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
  process.env.CODIGO_ETIQUETADOR_CORREOS = "AZXT";
  process.env.AMPHORA_DOMESTIC_PREREGISTER = "off";
});

describe("storing the label PDF", () => {
  it("keeps the PDF against the tracking number it belongs to", async () => {
    const { createShippingLabel } = await load();

    await createShippingLabel(ORDER.id);

    expect(saved).toEqual([
      { orderId: ORDER.id, trackingNumber: TRACKING, pdfBase64: PDF },
    ]);
  });

  it("attaches the same PDF it stored", async () => {
    const { createShippingLabel } = await load();

    await createShippingLabel(ORDER.id);

    const attachment = posted[0]?.Attachments?.find(
      (a: any) => a.Name === "Return_label.pdf"
    );
    expect(attachment?.Content).toBe(PDF);
  });

  it("stores the PDF even when the email then fails", async () => {
    // The whole point: the send failing is exactly when we will need it again.
    behaviour.emailFails = true;
    const { createShippingLabel } = await load();

    await createShippingLabel(ORDER.id);

    expect(saved).toHaveLength(1);
  });

  it("stores nothing when Correos returned no label", async () => {
    behaviour.correos = CORREOS_NO_PDF;
    const { createShippingLabel } = await load();

    await createShippingLabel(ORDER.id);

    expect(saved).toHaveLength(0);
    // And it must not send an email claiming a label is attached.
    expect(posted).toHaveLength(0);
  });

  it("stores nothing when Correos rejected the shipment", async () => {
    behaviour.correos = CORREOS_REJECTED;
    const { createShippingLabel } = await load();

    await createShippingLabel(ORDER.id);

    expect(saved).toHaveLength(0);
  });
});

describe("re-sending a stored label", () => {
  it("emails the stored PDF without touching Correos", async () => {
    storedLabel = { trackingNumber: TRACKING, pdfBase64: PDF };
    const { resendReturnLabel } = await load();

    await expect(resendReturnLabel(ORDER.id)).resolves.toBe(200);

    expect(posted).toHaveLength(1);
    const attachment = posted[0].Attachments.find(
      (a: any) => a.Name === "Return_label.pdf"
    );
    expect(attachment.Content).toBe(PDF);
    // No second parcel: nothing was registered.
    expect(saved).toHaveLength(0);
  });

  it("refuses rather than silently registering a new parcel when we hold no PDF", async () => {
    storedLabel = null;
    const { resendReturnLabel } = await load();

    // 409, not 200 and not a fresh registration — re-registering costs a real
    // uncancellable shipment and must be a deliberate choice.
    await expect(resendReturnLabel(ORDER.id)).resolves.toBe(409);
    expect(posted).toHaveLength(0);
  });

  it("reports a failed re-send instead of claiming success", async () => {
    storedLabel = { trackingNumber: TRACKING, pdfBase64: PDF };
    behaviour.emailFails = true;
    const { resendReturnLabel } = await load();

    await expect(resendReturnLabel(ORDER.id)).resolves.not.toBe(200);
  });
});

describe("extractLabelPdf", () => {
  // Pure, and deliberately NOT exported from the "use server" module — every
  // export there must be async or the Next build fails, which neither tsc nor
  // vitest will tell you.
  it("pulls the PDF out of a real response shape", async () => {
    const { extractLabelPdf } = await import("@/lib/correosLabel");
    expect(extractLabelPdf(CORREOS_OK)).toBe(PDF);
  });

  it("returns null when the response carries no label", async () => {
    const { extractLabelPdf } = await import("@/lib/correosLabel");
    expect(extractLabelPdf(CORREOS_NO_PDF)).toBeNull();
  });
});
