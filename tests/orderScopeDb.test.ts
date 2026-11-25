import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";
import { customerCtx, vid } from "./support/verified";

// The order-scoped DAL (F1 spec §3) against Postgres. Every write carries the
// verified order id in its own WHERE, so a row id from the browser that names
// another order's row matches nothing: `not-editable`, never a silent write.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));

/** What Shopify says about each variant (db/queries `getVariantsByIds`). */
const catalogue: Record<string, any> = {};
vi.mock("@/db/queries", () => ({
  getVariantsByIds: async (ids: string[]) =>
    Object.fromEntries(ids.filter((id) => catalogue[id]).map((id) => [id, catalogue[id]])),
}));

const VARIANT = (n: number) => `gid://shopify/ProductVariant/${n}`;
const variant = (title: string, productStatus: string, inventoryQuantity: number) => ({
  productTitle: "Other jeans",
  variantTitle: title,
  productId: "gid://shopify/Product/2",
  productStatus,
  inventoryQuantity,
  availableForSale: inventoryQuantity > 0,
});

const scope = async (id: string) => (await import("@/lib/server/orderScope")).orderScope(vid(id));
const row = async (id: number) => (await env.pg.query<any>("SELECT * FROM productsorder WHERE id = $1", [id])).rows[0];
const order = async (id: string) => (await env.pg.query<any>("SELECT * FROM orders WHERE id = $1", [id])).rows[0];

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(catalogue)) delete catalogue[k];
  catalogue[VARIANT(9)] = variant("L", "ACTIVE", 3); // another product: cross-product exchange
  catalogue[VARIANT(10)] = variant("XL", "ACTIVE", 0); // out of stock
  catalogue[VARIANT(11)] = variant("S", "DRAFT", 5); // not on sale
  await env.pg.exec(`
    INSERT INTO orders (id, order_number, shipping_country, delivery_name, delivery_address1,
      delivery_zip, delivery_city, delivery_country)
    VALUES ('A', '#A', 'Spain', 'Ana', 'Calle 1', '28001', 'Madrid', 'ES'),
           ('B', '#B', 'Spain', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id,
      price, quantity, confirmed)
    VALUES (1, 'A', 'li1', 'p', 't', 'M', 'v1', '50.00', 1, NULL),
           (2, 'B', 'li2', 'p', 't', 'M', 'v1', '50.00', 1, NULL),
           (3, 'A', 'li3', 'p', 't', 'M', 'v1', '50.00', 1, true);`);
});

describe("setLineSelection", () => {
  it("saves an exchange to an offered variant of ANOTHER product, titled by Shopify", async () => {
    const s = await scope("A");
    expect(
      await s.setLineSelection(1, { action: "CAMBIO", reason: "TOO_BIG", notes: "n", newVariantId: VARIANT(9) })
    ).toEqual({ ok: true, value: {} });
    expect(await row(1)).toMatchObject({
      action: "CAMBIO",
      changed: true,
      new_variant_id: VARIANT(9),
      new_variant_title: "L",
      variant_id: "v1",
      line_item: "li1",
    });
  });

  it("accepts a bare numeric variant id, stored as the full GID", async () => {
    const s = await scope("A");
    await s.setLineSelection(1, { action: "CAMBIO", reason: "TOO_BIG", notes: "", newVariantId: "9" });
    expect((await row(1)).new_variant_id).toBe(VARIANT(9));
  });

  it.each([
    ["out of stock", VARIANT(10)],
    ["not an active product", VARIANT(11)],
    ["unknown to Shopify", VARIANT(99)],
    ["not a variant id", "gid://shopify/Product/2"],
  ])("refuses a replacement the dialog does not offer (%s)", async (_label, id) => {
    const s = await scope("A");
    expect(
      await s.setLineSelection(1, { action: "CAMBIO", reason: "TOO_BIG", notes: "", newVariantId: id })
    ).toEqual({ ok: false, reason: "variant-not-offered" });
    expect((await row(1)).action).toBeNull();
  });

  it("refuses another order's row: not-editable, and that row is untouched", async () => {
    const s = await scope("A");
    expect(await s.setLineSelection(2, { action: "DEVOLUCIÓN", reason: "TOO_BIG", notes: "x" })).toEqual({
      ok: false,
      reason: "not-editable",
    });
    expect(await row(2)).toMatchObject({ action: null, reason: null, notes: null });
  });

  it("refuses a row already confirmed (submitted)", async () => {
    const s = await scope("A");
    expect(await s.setLineSelection(3, { action: "DEVOLUCIÓN", reason: "TOO_BIG", notes: "x" })).toEqual({
      ok: false,
      reason: "not-editable",
    });
  });
});

describe("clearLineSelection", () => {
  it("refuses another order's row and leaves it as it was", async () => {
    await env.pg.exec(`UPDATE productsorder SET action = 'DEVOLUCIÓN', reason = 'size' WHERE id = 2`);
    const s = await scope("A");
    expect(await s.clearLineSelection(2)).toEqual({ ok: false, reason: "not-editable" });
    expect((await row(2)).action).toBe("DEVOLUCIÓN");
  });

  it("clears this order's own row", async () => {
    await env.pg.exec(`UPDATE productsorder SET action = 'DEVOLUCIÓN', reason = 'size' WHERE id = 1`);
    const s = await scope("A");
    expect(await s.clearLineSelection(1)).toEqual({ ok: true, value: {} });
    expect((await row(1)).action).toBeNull();
  });
});

describe("saveAddress (handler + scope)", () => {
  const address = {
    name: "Ana",
    address1: "Calle 2",
    zip: "28002",
    city: "Madrid",
    delivery: null,
    deliveryBlockOffered: false,
  };
  const save = async (id: string, input: any) => {
    const { saveAddressHandler } = await import("@/lib/server/handlers/customer/address");
    return saveAddressHandler(await customerCtx(id), input);
  };

  it("writes this order's collection address only, never the country", async () => {
    expect(await save("A", address)).toEqual({ ok: true, value: {} });
    expect(await order("A")).toMatchObject({ shipping_address1: "Calle 2", shipping_country: "Spain" });
    expect((await order("B")).shipping_address1).toBeNull();
  });

  it("leaves a stored delivery address alone when the block was not offered", async () => {
    await save("A", address);
    expect(await order("A")).toMatchObject({ delivery_name: "Ana", delivery_country: "ES" });
  });

  it("clears the delivery address when the offered block came back empty", async () => {
    await save("A", { ...address, deliveryBlockOffered: true });
    expect(await order("A")).toMatchObject({ delivery_name: null, delivery_country: null });
  });

  it("writes a complete delivery block, normalising the country", async () => {
    const delivery = { name: "Bo", address1: "Rue 1", zip: "75001", city: "Paris", country: "France" };
    await save("A", { ...address, delivery, deliveryBlockOffered: true });
    expect(await order("A")).toMatchObject({ delivery_name: "Bo", delivery_country: "FR" });
  });

  it("refuses a partial delivery block or an unsupported country, writing nothing", async () => {
    const partial = { name: "Bo", address1: "", zip: "", city: "", country: "" };
    expect(await save("A", { ...address, delivery: partial, deliveryBlockOffered: true })).toEqual({
      ok: false,
      reason: "invalid-delivery",
    });
    const nowhere = { name: "Bo", address1: "Rue 1", zip: "1", city: "X", country: "Atlantis" };
    expect(await save("A", { ...address, delivery: nowhere, deliveryBlockOffered: true })).toEqual({
      ok: false,
      reason: "invalid-delivery",
    });
    expect((await order("A")).shipping_address1).toBeNull();
  });

  it("refuses an incomplete collection address (name, street or city missing)", async () => {
    for (const missing of ["name", "address1", "city"]) {
      expect(await save("A", { ...address, [missing]: " " })).toEqual({ ok: false, reason: "incomplete" });
    }
    expect((await order("A")).shipping_address1).toBeNull();
  });

  it("saves without a zip, which stays optional (spec §10)", async () => {
    const { zip: _zip, ...noZip } = address;
    expect(await save("A", noZip)).toEqual({ ok: true, value: {} });
    expect(await save("A", { ...address, zip: "" })).toEqual({ ok: true, value: {} });
  });
});
