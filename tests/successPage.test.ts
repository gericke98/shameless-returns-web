import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dictionaries } from "@/lib/i18n";

// The page reached whether the return worked or not. `returnFunction` ends in
// an unconditional redirect("/success"), so arriving here proves nothing — and
// for order #310185 on 2026-08-05 it proved the opposite of what it showed.
// These pin that the page reports what actually happened.

const currentOrderId = vi.fn();
const getOrderById = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => ({
    // Locale pinned to English so the assertions read as prose.
    get: (name: string) =>
      name === "locale" ? { name, value: "en" } : undefined,
  }),
}));

vi.mock("@/lib/orderAccess", () => ({
  currentOrderId: () => currentOrderId(),
}));

vi.mock("@/db/queries", () => ({
  getOrderById: (id: string) => getOrderById(id),
}));

const t = dictionaries.en;

async function render() {
  const { default: SuccessPage } = await import("@/app/success/page");
  return renderToStaticMarkup(await (SuccessPage as any)());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the success page", () => {
  it("confirms a return that actually exists", async () => {
    currentOrderId.mockResolvedValue("13092191797574");
    getOrderById.mockResolvedValue({
      products: [{ confirmed: true }],
      locator: null,
    });

    const html = await render();

    expect(html).toContain(t.success.title);
    expect(html).not.toContain(t.error.title);
  });

  it("shows the tracking it holds", async () => {
    currentOrderId.mockResolvedValue("13092191797574");
    getOrderById.mockResolvedValue({
      products: [{ confirmed: true }],
      locator: "JJD00026866036667489001",
      carrier: "DHP",
      carrierUrl: "https://clientesparcel.dhl.es/x",
    });

    const html = await render();

    expect(html).toContain("JJD00026866036667489001");
    expect(html).toContain("https://clientesparcel.dhl.es/x");
  });

  it("does NOT claim success when no return was created", async () => {
    // The reverted return. This is the whole reason the page changed.
    currentOrderId.mockResolvedValue("13092191797574");
    getOrderById.mockResolvedValue({ products: [{ confirmed: false }] });

    const html = await render();

    expect(html).toContain(t.error.title);
    expect(html).not.toContain(t.success.title);
  });

  it("offers a way back to the order when the return failed", async () => {
    currentOrderId.mockResolvedValue("13092191797574");
    getOrderById.mockResolvedValue({ products: [] });

    const html = await render();

    expect(html).toContain("/13092191797574");
  });

  it("falls back to neutral copy when the session has expired", async () => {
    // Never assert a failure we cannot prove: the TTL is two hours and a slow
    // Stripe checkout can outlive it.
    currentOrderId.mockResolvedValue(null);

    const html = await render();

    expect(html).toContain(t.success.title);
    expect(html).not.toContain(t.error.title);
    expect(getOrderById).not.toHaveBeenCalled();
  });

  it("falls back to neutral copy when the order cannot be loaded", async () => {
    currentOrderId.mockResolvedValue("13092191797574");
    getOrderById.mockResolvedValue(null);

    const html = await render();

    expect(html).toContain(t.success.title);
    expect(html).not.toContain(t.error.title);
  });
});
