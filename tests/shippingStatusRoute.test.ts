import { beforeEach, describe, expect, it, vi } from "vitest";

// The seams around the pure parser: the network call in `obtainLastStatus` and
// the route that serves it to the dashboard.
//
// The old route did `(await obtainLastStatus(locator)) ?? locator`, so a lookup
// that told us NOTHING answered with the tracking NUMBER — which the dashboard
// then rendered in the Status column. An unanswerable question looked like an
// answer.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));
vi.mock("@/db/queries", () => ({ getOrderById: async () => null }));

const axiosGet = vi.fn();
vi.mock("axios", () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

const DELIVERED = [
  {
    codEnvio: "PQAZXT9800004250128221N",
    eventos: [{ desFase: "ENTREGADO", desTextoResumen: "Entregado" }],
    error: { codError: "0", desError: "" },
    resumen_ultimo: "Entregado",
  },
];

const NO_TRACEABILITY = [
  {
    codEnvio: "PQAZXT0710002040128224R",
    eventos: null,
    error: { codError: "3", desError: "Sin Trazabilidad en Minerva." },
    resumen_ultimo: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.USERNAME_CORREOS = "user";
  process.env.PASSWORD_CORREOS = "pass";
});

describe("obtainLastStatus", () => {
  it("reports what Correos returned", async () => {
    axiosGet.mockResolvedValue({ data: DELIVERED });
    const { obtainLastStatus } = await import("@/actions/shipping");

    const status = await obtainLastStatus("PQAZXT9800004250128221N");

    expect(status).toEqual({ label: "Entregado", phase: "entregado" });
  });

  it("reports unknown — not Prerregistrado — when Correos has no traceability", async () => {
    axiosGet.mockResolvedValue({ data: NO_TRACEABILITY });
    const { obtainLastStatus } = await import("@/actions/shipping");

    const status = await obtainLastStatus("PQAZXT0710002040128224R");

    expect(status.phase).toBe("sin_informacion");
    expect(status.label).not.toBe("Prerregistrado");
  });

  it("bounds the request, so one hung socket cannot stall the whole sweep", async () => {
    // Axios has NO default timeout. The hourly tracking sweep calls this
    // sequentially inside a 300-second function, so a socket the localizador
    // never closes takes every parcel behind it down with it.
    axiosGet.mockResolvedValue({ data: DELIVERED });
    const { obtainLastStatus } = await import("@/actions/shipping");

    await obtainLastStatus("PQAZXT9800004250128221N");

    expect(axiosGet.mock.calls[0][1]).toMatchObject({ timeout: 10_000 });
  });

  it("treats a network failure as unknown, never as a status", async () => {
    // A timeout is not evidence about the parcel.
    axiosGet.mockRejectedValue(new Error("ETIMEDOUT"));
    const { obtainLastStatus } = await import("@/actions/shipping");

    expect((await obtainLastStatus("PQ123")).phase).toBe("sin_informacion");
  });

  it("does not call Correos at all without credentials", async () => {
    delete process.env.USERNAME_CORREOS;
    const { obtainLastStatus } = await import("@/actions/shipping");

    const status = await obtainLastStatus("PQ123");

    expect(axiosGet).not.toHaveBeenCalled();
    expect(status.phase).toBe("sin_informacion");
  });

  it("does not call Correos for a null locator", async () => {
    const { obtainLastStatus } = await import("@/actions/shipping");

    expect((await obtainLastStatus(null)).phase).toBe("sin_informacion");
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("url-encodes the locator", async () => {
    // The locator reaches this from a query string; it must not be able to
    // append its own path segments or query parameters to the Correos URL.
    axiosGet.mockResolvedValue({ data: DELIVERED });
    const { obtainLastStatus } = await import("@/actions/shipping");

    await obtainLastStatus("PQ/123?x=1");

    expect(axiosGet.mock.calls[0][0]).toContain("PQ%2F123%3Fx%3D1");
  });
});

describe("GET /api/shipping-status", () => {
  const call = async (url: string) => {
    const { GET } = await import("@/app/api/shipping-status/route");
    const response = await GET(new Request(url));
    return { status: response.status, body: await response.json() };
  };

  it("rejects a request with no locator", async () => {
    const { status } = await call("https://x.test/api/shipping-status");
    expect(status).toBe(400);
  });

  it("returns the label and the canonical phase", async () => {
    axiosGet.mockResolvedValue({ data: DELIVERED });

    const { body } = await call("https://x.test/api/shipping-status?locator=PQ1");

    expect(body).toEqual({ locator: "PQ1", label: "Entregado", phase: "entregado" });
  });

  it("never answers with the tracking number as the status", async () => {
    // The old `?? locator` fallback put "PQ1" in the Status column.
    axiosGet.mockRejectedValue(new Error("down"));

    const { body } = await call("https://x.test/api/shipping-status?locator=PQ1");

    expect(body.label).not.toBe("PQ1");
    expect(body.phase).toBe("sin_informacion");
  });
});
