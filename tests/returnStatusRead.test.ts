import { afterEach, describe, expect, it, vi } from "vitest";

// The auto-approve gate treats a status it cannot read as ineligible. That is
// only safe if this reader never invents one — a return Shopify does not return
// must be ABSENT from the map, not defaulted.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("@/db/drizzle", () => ({ default: {} }));

const calls: any[] = [];
function mockFetch(payloads: any[]) {
  let i = 0;
  return vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const payload = payloads[Math.min(i++, payloads.length - 1)];
    return { ok: true, json: async () => payload } as any;
  });
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

async function subject() {
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.test";
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  return (await import("@/db/queries")).getReturnStatusesByIds;
}

describe("getReturnStatusesByIds", () => {
  it("maps each return gid to its status", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [
      { id: "gid://shopify/Return/1", status: "OPEN" },
      { id: "gid://shopify/Return/2", status: "CLOSED" },
    ] } }]));

    const get = await subject();
    expect(await get(["gid://shopify/Return/1", "gid://shopify/Return/2"])).toEqual({
      "gid://shopify/Return/1": "OPEN",
      "gid://shopify/Return/2": "CLOSED",
    });
  });

  it("omits a return Shopify did not return, rather than defaulting it", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [null] } }]));

    const get = await subject();
    expect(await get(["gid://shopify/Return/404"])).toEqual({});
  });

  it("makes no network call for an empty list", async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal("fetch", fetchMock);

    const get = await subject();
    expect(await get([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("de-duplicates ids before asking", async () => {
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [{ id: "gid://shopify/Return/1", status: "OPEN" }] } }]));

    const get = await subject();
    await get(["gid://shopify/Return/1", "gid://shopify/Return/1"]);
    expect(calls[0].variables.ids).toEqual(["gid://shopify/Return/1"]);
  });

  it("batches beyond 40 ids into separate requests", async () => {
    const ids = Array.from({ length: 41 }, (_, i) => `gid://shopify/Return/${i}`);
    vi.stubGlobal("fetch", mockFetch([{ data: { nodes: [] } }]));

    const get = await subject();
    await get(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0].variables.ids).toHaveLength(40);
    expect(calls[1].variables.ids).toHaveLength(1);
  });

  it("throws rather than returning a partial map when Shopify errors", async () => {
    // A partial map reads to the gate as "unreadable", which is safe — but a
    // silent partial across a 25-line run hides a broken integration. Loud.
    vi.stubGlobal("fetch", mockFetch([{ errors: [{ message: "Throttled" }] }]));

    const get = await subject();
    await expect(get(["gid://shopify/Return/1"])).rejects.toThrow();
  });
});
