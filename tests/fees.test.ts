import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_KEY,
  UNBOUNDED_MAX_GRAMS,
  centsToEuros,
  feesForCountry,
  feesForWeight,
  checkoutLines,
  resolveFee,
  type FeeTable,
} from "@/lib/fees";
import { FALLBACK_ITEM_GRAMS, valueBasket } from "@/lib/basket";

/** A country priced the same at every weight — the pre-band behaviour. */
const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(2000, 1500),
  ES: flat(400, 0),
  FR: flat(900, 600),
};

describe("feesForCountry", () => {
  it("returns the country's own bands when present", () => {
    expect(feesForCountry(TABLE, "ES")).toEqual(flat(400, 0));
    expect(feesForCountry(TABLE, "FR")).toEqual(flat(900, 600));
  });

  it("falls back to the default bands for a country with no rows", () => {
    expect(feesForCountry(TABLE, "DE")).toEqual(flat(2000, 1500));
  });

  it("falls back to the default bands for a null country", () => {
    expect(feesForCountry(TABLE, null)).toEqual(flat(2000, 1500));
  });

  it("falls back to the default when a country is present but has no bands", () => {
    // A country key with an empty array is not "priced at zero" — it is
    // unpriced, and must inherit rather than silently charge nothing.
    expect(feesForCountry({ ...TABLE, DE: [] }, "DE")).toEqual(flat(2000, 1500));
  });

  it("returns no bands when even the default is missing", () => {
    expect(feesForCountry({}, "ES")).toEqual([]);
  });

  it("marks band fields readonly so cached rows cannot be mutated by mistake", () => {
    // Isolated table (not the shared TABLE above): `readonly` is a
    // compile-time-only guard — Vitest's esbuild transform strips types
    // without checking them, so the `@ts-expect-error` line below still
    // *executes* at runtime and mutates whatever object it aliases.
    const isolated: FeeTable = { ES: flat(400, 0) };
    const bands = feesForCountry(isolated, "ES");
    expect(bands[0].returnFeeCents).toBe(400);
    // The actual regression guard is `npx tsc --noEmit`, not this runtime
    // assertion: if `readonly` is ever removed from `CountryFees`, this
    // assignment stops being a type error, the directive below becomes
    // unused, and tsc fails with "Unused '@ts-expect-error' directive".
    // @ts-expect-error readonly: mutating a cached fee row must not compile
    bands[0].returnFeeCents = 0;
  });
});

describe("feesForWeight", () => {
  // Shaped like a real country: cheap under a kilo, steeper above.
  const BANDS = [
    { maxGrams: 1000, returnFeeCents: 1000, exchangeFeeCents: 900 },
    { maxGrams: 3000, returnFeeCents: 1300, exchangeFeeCents: 1200 },
    { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 2100, exchangeFeeCents: 2000 },
  ];

  it("picks the first band the parcel fits", () => {
    expect(feesForWeight(BANDS, 500).returnFeeCents).toBe(1000);
    expect(feesForWeight(BANDS, 2000).returnFeeCents).toBe(1300);
    expect(feesForWeight(BANDS, 9000).returnFeeCents).toBe(2100);
  });

  it("treats maxGrams as inclusive", () => {
    // A parcel of exactly 1000g belongs to the <=1kg band, not the next one.
    expect(feesForWeight(BANDS, 1000).returnFeeCents).toBe(1000);
    expect(feesForWeight(BANDS, 1001).returnFeeCents).toBe(1300);
  });

  it("charges the lightest band for a zero or negative weight", () => {
    // A bad weight must not block a return, and must not silently land in
    // the most expensive band either.
    expect(feesForWeight(BANDS, 0).returnFeeCents).toBe(1000);
    expect(feesForWeight(BANDS, -5).returnFeeCents).toBe(1000);
    expect(feesForWeight(BANDS, NaN).returnFeeCents).toBe(1000);
  });

  it("charges zero when a country has no bands at all", () => {
    expect(feesForWeight([], 500)).toEqual({ returnFeeCents: 0, exchangeFeeCents: 0 });
  });

  it("falls back to the heaviest band when none is unbounded", () => {
    // The seed forbids this shape, but a hand-edited dashboard row could
    // produce it. Charging the top band beats charging nothing.
    const capped = [{ maxGrams: 1000, returnFeeCents: 1000, exchangeFeeCents: 900 }];
    expect(feesForWeight(capped, 50_000).returnFeeCents).toBe(1000);
  });

  it("never charges less for a heavier parcel", () => {
    let previous = -1;
    for (let grams = 0; grams <= 12_000; grams += 250) {
      const fee = feesForWeight(BANDS, grams).returnFeeCents;
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
  });
});

describe("resolveFee — Rule A, by net amount", () => {
  const es = TABLE.ES;

  it("charges nothing for an empty basket", () => {
    expect(resolveFee(es, { hasItems: false, netAmount: 0, grams: 0 })).toMatchObject({
      feeCents: 0,
      kind: "none",
    });
  });

  it("charges the return fee when money flows back to the customer", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: 42.5, grams: 0 })).toMatchObject({
      feeCents: 400,
      kind: "return",
    });
  });

  it("charges the exchange fee when the customer owes money", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: -12, grams: 0 })).toMatchObject({
      feeCents: 0,
      kind: "exchange",
    });
  });

  it("charges the exchange fee on an even swap", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 0, grams: 0 })).toMatchObject({
      feeCents: 600,
      kind: "exchange",
    });
  });

  // The divergence that made summary.tsx and the Stripe amount disagree:
  // a pure exchange for a CHEAPER item leaves netAmount > 0, so Rule A
  // charges the return fee. Rule B charged the exchange fee here.
  it("charges the return fee on an exchange for a cheaper item", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 5, grams: 0 })).toMatchObject({
      feeCents: 900,
      kind: "return",
    });
  });

  it("ignores netAmount entirely when the basket is empty", () => {
    expect(resolveFee(TABLE.FR, { hasItems: false, netAmount: 99, grams: 0 })).toMatchObject({
      feeCents: 0,
      kind: "none",
    });
  });

  // The bug this whole change exists to fix: a five-garment basket weighs
  // past the first band, and used to be charged the sub-1kg price anyway.
  describe("weight selects the band, Rule A selects which fee in it", () => {
    const BANDED = [
      { maxGrams: 1000, returnFeeCents: 1000, exchangeFeeCents: 900 },
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 2100, exchangeFeeCents: 2000 },
    ];

    it("charges the heavier band's return fee for a heavy basket", () => {
      expect(resolveFee(BANDED, { hasItems: true, netAmount: 50, grams: 2500 })).toMatchObject({
        feeCents: 2100,
        kind: "return",
      });
    });

    it("charges the heavier band's exchange fee for a heavy even swap", () => {
      expect(resolveFee(BANDED, { hasItems: true, netAmount: 0, grams: 2500 })).toMatchObject({
        feeCents: 2000,
        kind: "exchange",
      });
    });

    it("keeps weight and Rule A independent", () => {
      // Same weight, opposite sign: the band is identical, only the fee
      // within it differs.
      const heavyReturn = resolveFee(BANDED, { hasItems: true, netAmount: 1, grams: 5000 });
      const heavyExchange = resolveFee(BANDED, { hasItems: true, netAmount: -1, grams: 5000 });
      expect(heavyReturn.kind).toBe("return");
      expect(heavyExchange.kind).toBe("exchange");
      expect(heavyReturn.feeCents).toBe(2100);
      expect(heavyExchange.feeCents).toBe(2000);
    });

    it("still charges nothing for an empty basket however heavy", () => {
      expect(resolveFee(BANDED, { hasItems: false, netAmount: 0, grams: 9999 })).toMatchObject({
        feeCents: 0,
        kind: "none",
        returnLegCents: 0,
        outboundLegCents: 0,
      });
    });
  });

  describe("shipping legs, for display", () => {
    // An exchange pays for two journeys, so the summary shows both. The split
    // is derived rather than stored — outbound is whatever the exchange fee
    // exceeds the return fee by.
    const BANDS = [
      { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 1100, exchangeFeeCents: 1820 },
    ];

    it("reports one leg for a return", () => {
      const fee = resolveFee(BANDS, { hasItems: true, netAmount: 40, grams: 400 });
      expect(fee).toMatchObject({
        kind: "return",
        feeCents: 1100,
        returnLegCents: 1100,
        outboundLegCents: 0,
      });
    });

    it("splits an exchange into the parcel back and the replacement out", () => {
      const fee = resolveFee(BANDS, { hasItems: true, netAmount: -5, grams: 400 });
      expect(fee).toMatchObject({
        kind: "exchange",
        feeCents: 1820,
        returnLegCents: 1100,
        outboundLegCents: 720,
      });
    });

    it("always has the legs add up to exactly what is charged", () => {
      // The two rendered lines must reconcile to the amount taken, or the
      // breakdown is lying about the total.
      for (const netAmount of [50, 0, -50]) {
        for (const grams of [0, 500, 4000]) {
          const fee = resolveFee(BANDS, { hasItems: true, netAmount, grams });
          expect(fee.returnLegCents + fee.outboundLegCents).toBe(fee.feeCents);
        }
      }
    });

    it("keeps the legs reconciling even if a row makes an exchange cheaper", () => {
      // Nothing should be able to produce a negative line. A hand-edited
      // dashboard row could invert the two fees; the whole amount then shows
      // as the return leg rather than as a negative delivery.
      const inverted = [
        { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents: 1100, exchangeFeeCents: 900 },
      ];
      const fee = resolveFee(inverted, { hasItems: true, netAmount: -5, grams: 400 });
      expect(fee.outboundLegCents).toBe(0);
      expect(fee.returnLegCents).toBe(900);
      expect(fee.returnLegCents + fee.outboundLegCents).toBe(fee.feeCents);
    });
  });
});

describe("centsToEuros", () => {
  it("converts without float drift", () => {
    expect(centsToEuros(419)).toBe(4.19);
    expect(centsToEuros(0)).toBe(0);
    expect(centsToEuros(2000)).toBe(20);
  });
});

const product = (variantId: string, price: string) => ({
  id: "gid://shopify/Product/1",
  title: "T",
  handle: "t",
  description: "",
  images: { edges: [] },
  variants: { edges: [{ node: { id: variantId, price } }] },
}) as any;

const line = (over: Record<string, unknown>) => ({
  id: 1, lineItemId: "1", orderId: "o", productId: "1", title: "T",
  variant_title: "M", variant_id: "v1", price: "30.00", quantity: 1,
  changed: false, action: null, reason: null, notes: null,
  new_variant_title: null, new_variant_id: null, confirmed: false,
  return_id: null, refunded: null, credit: null, gift_card_id: null,
  return_line_item_id: null, transaction_id: null, transaction_amount: null,
  ...over,
}) as any;

describe("valueBasket", () => {
  it("reports an empty basket when nothing is selected", () => {
    expect(valueBasket([line({})], [])).toMatchObject({ hasItems: false, netAmount: 0 });
  });

  it("ignores lines already confirmed", () => {
    const b = valueBasket([line({ action: "DEVOLUCIÓN", confirmed: true })], []);
    expect(b.hasItems).toBe(false);
  });

  it("values a pure return at the line price", () => {
    const b = valueBasket([line({ action: "DEVOLUCIÓN" })], []);
    expect(b).toMatchObject({ returnPrice: 30, exchangePrice: 0, netAmount: 30, hasItems: true });
  });

  it("nets an exchange against the replacement variant price", () => {
    const b = valueBasket(
      [line({ action: "CAMBIO", new_variant_id: "v2" })],
      [product("v2", "25.00")]
    );
    expect(b).toMatchObject({ returnPrice: 30, exchangePrice: 25, netAmount: 5 });
  });

  it("falls back to the original price when the variant is missing", () => {
    const b = valueBasket([line({ action: "CAMBIO", new_variant_id: "gone" })], []);
    expect(b.netAmount).toBe(0);
  });
});

const weighted = (variantId: string, grams: number | null) => ({
  id: "gid://shopify/Product/9",
  title: "W",
  handle: "w",
  description: "",
  images: { edges: [] },
  variants: { edges: [{ node: { id: variantId, price: "30.00", grams } }] },
}) as any;

describe("parcel weight", () => {
  it("weighs nothing when no item is selected", () => {
    expect(valueBasket([line({})], [weighted("v1", 400)]).grams).toBe(0);
  });

  it("sums the catalogue weight of the selected items", () => {
    const b = valueBasket(
      [line({ action: "DEVOLUCIÓN" }), line({ variant_id: "v2", action: "DEVOLUCIÓN" })],
      [weighted("v1", 400), weighted("v2", 900)]
    );
    expect(b.grams).toBe(1300);
  });

  it("multiplies by quantity", () => {
    const b = valueBasket(
      [line({ action: "DEVOLUCIÓN", quantity: 3 })],
      [weighted("v1", 400)]
    );
    expect(b.grams).toBe(1200);
  });

  it("weighs the ORIGINAL variant on an exchange, not the replacement", () => {
    // The customer ships back what they had; the replacement travels
    // separately and is not in this parcel.
    const b = valueBasket(
      [line({ action: "CAMBIO", new_variant_id: "v2" })],
      [weighted("v1", 400), weighted("v2", 900)]
    );
    expect(b.grams).toBe(400);
  });

  it("uses the fallback weight for a variant missing from the catalogue", () => {
    // Zero would be the dangerous default — an unknown item would make the
    // parcel look lighter and so make the return cheaper.
    const b = valueBasket([line({ action: "DEVOLUCIÓN" })], []);
    expect(b.grams).toBe(FALLBACK_ITEM_GRAMS);
  });

  it("uses the fallback weight for a variant with no weight set", () => {
    const b = valueBasket([line({ action: "DEVOLUCIÓN" })], [weighted("v1", null)]);
    expect(b.grams).toBe(FALLBACK_ITEM_GRAMS);
  });

  it("puts a five-garment basket past the first kilo", () => {
    // The regression that motivated weight bands: five average garments at
    // the catalogue median weigh well over 1kg, so they must not be priced
    // in the sub-1kg band.
    const items = Array.from({ length: 5 }, () => line({ action: "DEVOLUCIÓN" }));
    const b = valueBasket(items, [weighted("v1", 423)]);
    expect(b.grams).toBeGreaterThan(2000);
  });
});

describe("checkoutLines", () => {
  // Stripe used to get one "Returns & Exchanges Fee" carrying everything,
  // including any price difference. These lines mirror the on-site summary so
  // the customer approves the same breakdown they were shown.
  const legs = (returnLegCents: number, outboundLegCents: number) => ({
    returnLegCents,
    outboundLegCents,
  });
  const basket = (netAmount: number) => ({ hasItems: true, netAmount, grams: 500 });

  it("splits an even exchange into its two shipping legs", () => {
    expect(checkoutLines(basket(0), legs(1100, 720), 1820)).toEqual([
      { kind: "returnShipping", amountCents: 1100 },
      { kind: "deliveryShipping", amountCents: 720 },
    ]);
  });

  it("adds a line for the price difference on a dearer replacement", () => {
    // 20.00 more for the new item, on top of the 18.20 of shipping.
    expect(checkoutLines(basket(-20), legs(1100, 720), 3820)).toEqual([
      { kind: "difference", amountCents: 2000 },
      { kind: "returnShipping", amountCents: 1100 },
      { kind: "deliveryShipping", amountCents: 720 },
    ]);
  });

  it("calls it plain shipping on a return, with no second leg", () => {
    expect(checkoutLines(basket(-5), legs(1100, 0), 1600)).toEqual([
      { kind: "difference", amountCents: 500 },
      { kind: "shipping", amountCents: 1100 },
    ]);
  });

  it("declines to itemise when the basket carries a credit", () => {
    // A cheaper replacement leaves netAmount > 0, which reduces the fee.
    // Stripe line items cannot be negative, so the caller falls back to one
    // line rather than charging a different total.
    expect(checkoutLines(basket(5), legs(1100, 0), 600)).toEqual([]);
  });

  it("declines to itemise rather than charge a different total", () => {
    // The guard that makes this safe: if the parts do not add up to the
    // amount, emit nothing and let the caller send a single correct line.
    expect(checkoutLines(basket(0), legs(1100, 720), 9999)).toEqual([]);
  });

  it("always sums to exactly the amount charged, or returns nothing", () => {
    for (const netAmount of [-40, -20, -0.01, 0, 5, 40]) {
      for (const [ret, out] of [[1100, 720], [500, 0], [8300, 2583]]) {
        const amountCents = Math.round((ret + out) / 1 - netAmount * 100);
        const lines = checkoutLines(basket(netAmount), legs(ret, out), amountCents);
        if (lines.length === 0) continue;
        const total = lines.reduce((s, l) => s + l.amountCents, 0);
        expect(total, `netAmount=${netAmount} legs=${ret}/${out}`).toBe(amountCents);
      }
    }
  });
});
