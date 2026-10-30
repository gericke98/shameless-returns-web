import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";

// The cancellation primitives, moved out of the "use server" db/queries.ts into
// lib/submissionCancellation.ts (S2 plan L2). The reset now runs as SQL inside
// the cancellation's final transaction, so it is tested against the real
// migrations in PGlite rather than against a mocked query builder.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: env.transact }));

let shopifyBody = "";
const shopifyResponse = { value: { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } } };

global.fetch = (async (_url: string, init: any) => {
  shopifyBody = String(init.body);
  return { json: async () => shopifyResponse.value };
}) as any;

beforeAll(() => env.ready);

beforeEach(async () => {
  await env.reset();
  shopifyBody = "";
  shopifyResponse.value = { data: { returnCancel: { return: { id: "gid://x" }, userErrors: [] } } };
  process.env.NEXT_PUBLIC_ACCESS_TOKEN = "token";
  process.env.NEXT_PUBLIC_SHOP_URL = "https://shop.myshopify.com";
});

describe("cancelShopifyReturn", () => {
  it("sends returnCancel for that return id", async () => {
    const { cancelShopifyReturn } = await import("@/lib/submissionCancellation");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(shopifyBody).toContain("returnCancel");
    expect(shopifyBody).toContain("gid://shopify/Return/1");
    expect(result.success).toBe(true);
  });

  it("sends the id as a GraphQL variable, never interpolated into the document", async () => {
    // Passing the raw id anywhere near the mutation string is the exact
    // injection pattern `createReturn`'s comment warns against — a document
    // that cancels a return being built from unescaped customer-reachable
    // input. `variables.id` is the only place it's allowed to appear.
    const { cancelShopifyReturn } = await import("@/lib/submissionCancellation");

    await cancelShopifyReturn("gid://shopify/Return/1");

    const parsed = JSON.parse(shopifyBody);
    expect(parsed.variables.id).toBe("gid://shopify/Return/1");
    expect(parsed.query).not.toContain("gid://shopify/Return/1");
  });

  it("reports failure on userErrors rather than throwing", async () => {
    // The caller has already cancelled Amphora and cannot undo it, so it needs
    // a value it can act on, not an exception mid-chain.
    shopifyResponse.value = {
      data: { returnCancel: { return: null, userErrors: [{ field: "id", message: "nope" }] } },
    } as any;
    const { cancelShopifyReturn } = await import("@/lib/submissionCancellation");

    const result = await cancelShopifyReturn("gid://shopify/Return/1");

    expect(result.success).toBe(false);
  });

  it("reports failure instead of throwing when the Shopify env vars are missing", async () => {
    // createSession() throws synchronously when these are unset. By the time
    // this function runs, the caller has already cancelled the Amphora return
    // and cannot undo that — an escaping throw here strands the customer with
    // no return and no refund, instead of a failure a caller can act on.
    delete process.env.NEXT_PUBLIC_ACCESS_TOKEN;
    delete process.env.NEXT_PUBLIC_SHOP_URL;
    const { cancelShopifyReturn } = await import("@/lib/submissionCancellation");

    await expect(cancelShopifyReturn("gid://shopify/Return/1")).resolves.toMatchObject({
      success: false,
    });
  });
});

const lib = () => import("@/lib/submissionCancellation");

async function seed() {
  await env.pg.exec(`
    INSERT INTO orders (id, order_number, locator, carrier, carrier_url, return_status,
      stripe_payment_intent, return_method, return_submitted_at, tracking_submitted_at,
      tracking_nudge_stage)
    VALUES ('1', '#1', 'PK1', 'UPS', 'https://t', 'APROVED', 'pi_1', 'SELF',
            '2026-08-18T09:00:00Z', NULL, 1),
           ('2', '#2', 'PK2', 'UPS', 'https://t2', 'APROVED', 'pi_2', 'SELF',
            '2026-08-18T09:00:00Z', NULL, 1);
    INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id,
      price, quantity, changed, action, reason, notes, new_variant_title, new_variant_id,
      confirmed, return_id, return_line_item_id, refunded)
    VALUES (1, '1', 'li1', 'p', 't', 'M', 'v1', '50.00', 1, true, 'CAMBIO', 'size', 'n', 'L',
            'gid://shopify/ProductVariant/9', true, 'gid://shopify/Return/1',
            'gid://shopify/ReturnLineItem/1', NULL),
           (2, '1', 'li2', 'p', 't', 'M', 'v2', '50.00', 1, false, 'DEVOLUCIÓN', 'fit', NULL, NULL,
            NULL, true, 'gid://shopify/Return/1', 'gid://shopify/ReturnLineItem/2', true),
           (3, '2', 'li3', 'p', 't', 'M', 'v1', '50.00', 1, true, 'CAMBIO', 'size', 'n', 'L',
            'gid://shopify/ProductVariant/9', true, 'gid://shopify/Return/2',
            'gid://shopify/ReturnLineItem/3', NULL);`);
}

const order = async (id: string) =>
  (await env.pg.query<any>("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const row = async (id: number) =>
  (await env.pg.query<any>("SELECT * FROM productsorder WHERE id = $1", [id])).rows[0];

describe("resetOrderReturn", () => {
  it("clears the tracking the cancelled return carried", async () => {
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect(await order("1")).toMatchObject({
      locator: null, carrier: null, carrier_url: null, return_status: null,
    });
  });

  it("clears the Stripe payment intent, so the NEXT return cannot reuse it", async () => {
    // Leaving `pi_1` behind poisons the next cancellation: a FREE second
    // return would be handed the old intent, and a paid one whose intent write
    // failed would never reach the session-lookup fallback.
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect((await order("1")).stripe_payment_intent).toBeNull();
  });

  it("clears the self-booked columns, so the cancelled return is neither chased nor blocking", async () => {
    // Cancel-before-posting is the PRIMARY self-booked cancel path. A
    // surviving `return_submitted_at` swallows the next self-booked return
    // (`if (order.returnSubmittedAt) return 200;`), and a surviving null
    // `tracking_submitted_at` gets the customer nudged about a cancelled one.
    await seed();
    await (await lib()).resetOrderReturn("1");

    const o = await order("1");
    expect(o).toMatchObject({
      return_method: null, return_submitted_at: null, tracking_submitted_at: null,
      tracking_nudge_stage: 0,
    });
    // The sweep's own predicate, evaluated by Postgres on the reset row.
    const chased = await env.pg.query<any>(
      `SELECT 1 FROM orders WHERE id = '1' AND return_method = 'SELF'
         AND return_submitted_at IS NOT NULL AND tracking_submitted_at IS NULL
         AND tracking_nudge_stage < 2`
    );
    expect(chased.rows).toHaveLength(0);
  });

  it("touches only the one order, not the whole table", async () => {
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect((await order("2")).locator).toBe("PK2");
    expect((await row(3)).confirmed).toBe(true);
    expect((await row(3)).return_id).toBe("gid://shopify/Return/2");
  });

  it("clears the confirmation and the Shopify return ids from every line", async () => {
    await seed();
    await (await lib()).resetOrderReturn("1");

    for (const id of [1, 2]) {
      expect(await row(id)).toMatchObject({ confirmed: false, return_id: null, return_line_item_id: null });
    }
  });

  it("keeps `refunded` — the permanent record that a garment was settled", async () => {
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect((await row(2)).refunded).toBe(true);
  });

  it("clears the exchange flag, not just the exchange data", async () => {
    // `changed` alone left a cancelled line struck through next to nothing
    // (#311258, cancelled 2026-08-13).
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect((await row(1)).changed).toBe(false);
  });

  it("clears the customer's selections so they get a clean wizard", async () => {
    await seed();
    await (await lib()).resetOrderReturn("1");

    expect(await row(1)).toMatchObject({
      action: null, reason: null, notes: null, new_variant_id: null, new_variant_title: null,
    });
  });
});
