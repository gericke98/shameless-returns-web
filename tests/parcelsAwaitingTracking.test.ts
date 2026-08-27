import { describe, expect, it, vi } from "vitest";

// What the hourly sweep is allowed to spend its 300 seconds on.
//
// The work list used to be "every order with a locator", ordered oldest-first.
// That is unbounded and it grows forever: the delivered rows accumulate while
// the live parcels are a handful, so a run truncated by `maxDuration` drops the
// SAME newest parcels every hour — the only ones that can still produce news.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

let captured: any = null;
let rows: any[] = [];

vi.mock("@/db/drizzle", () => ({
  default: {
    query: {
      orders: {
        findMany: async (config: any) => {
          captured = config;
          return rows;
        },
      },
    },
  },
}));

/** Render a drizzle predicate back to SQL-ish text, so the test asserts on the
 *  condition that reaches Postgres rather than on how it was spelled. */
function render(node: any): string {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(render).join("");
  if (typeof node !== "object") return String(node);
  if (node.queryChunks) return render(node.queryChunks);
  if (node.columnType && node.name) return String(node.name);
  if (Array.isArray(node.value)) return node.value.join("");
  if ("value" in node) return JSON.stringify(node.value);
  return "";
}

async function run() {
  const { getParcelsAwaitingTracking } = await import("@/db/queries");
  return getParcelsAwaitingTracking();
}

describe("getParcelsAwaitingTracking — what the sweep is allowed to cost", () => {
  it("leaves out parcels that have already reached their final milestone", async () => {
    rows = [];
    await run();

    const where = render(captured.where);
    expect(where).toContain("last_tracking_key");
    expect(where).toContain('"received"');
    expect(where).toContain("last_tracking_key is null");
  });

  it("leaves out a blank locator, not just a null one", async () => {
    // `isNotNull` alone lets `""` through, and asking the localizador about an
    // empty string spends a lookup to learn nothing.
    rows = [];
    await run();

    const where = render(captured.where);
    expect(where).toContain("locator is not null");
    expect(where).toContain('locator <> ""');
  });

  it("still orders oldest-first, so a capped run is deterministic", async () => {
    rows = [];
    await run();

    expect(captured.orderBy).toBeTypeOf("function");
  });

  it("still drops orders with nothing left to settle", async () => {
    // Unchanged, and re-pinned because the where-clause moved: once every line
    // is refunded there is nothing left to tell the customer about.
    rows = [
      { id: "1", locator: "PQ1", products: [{ refunded: false }] },
      { id: "2", locator: "PQ2", products: [{ refunded: true }] },
      { id: "3", locator: "PQ3", products: [] },
    ];

    const result = await run();

    expect(result.map((o: any) => o.id)).toEqual(["1"]);
  });
});
