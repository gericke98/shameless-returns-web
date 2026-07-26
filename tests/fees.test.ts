import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEE_KEY,
  centsToEuros,
  feesForCountry,
  resolveFee,
  type FeeTable,
} from "@/lib/fees";

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: { returnFeeCents: 2000, exchangeFeeCents: 1500 },
  ES: { returnFeeCents: 400, exchangeFeeCents: 0 },
  FR: { returnFeeCents: 900, exchangeFeeCents: 600 },
};

describe("feesForCountry", () => {
  it("returns the country's own row when present", () => {
    expect(feesForCountry(TABLE, "ES")).toEqual({ returnFeeCents: 400, exchangeFeeCents: 0 });
    expect(feesForCountry(TABLE, "FR")).toEqual({ returnFeeCents: 900, exchangeFeeCents: 600 });
  });

  it("falls back to the default row for a country with no row", () => {
    expect(feesForCountry(TABLE, "DE")).toEqual({ returnFeeCents: 2000, exchangeFeeCents: 1500 });
  });

  it("falls back to the default row for a null country", () => {
    expect(feesForCountry(TABLE, null)).toEqual({ returnFeeCents: 2000, exchangeFeeCents: 1500 });
  });

  it("returns zero fees when even the default row is missing", () => {
    expect(feesForCountry({}, "ES")).toEqual({ returnFeeCents: 0, exchangeFeeCents: 0 });
  });

  it("marks CountryFees fields readonly so cached rows cannot be mutated by mistake", () => {
    // Isolated table (not the shared TABLE above): `readonly` is a
    // compile-time-only guard — Vitest's esbuild transform strips types
    // without checking them, so the `@ts-expect-error` line below still
    // *executes* at runtime and mutates whatever object `fees` aliases.
    // Using a throwaway table here keeps that mutation from leaking into
    // other tests that read from the shared TABLE constant.
    const isolated: FeeTable = { ES: { returnFeeCents: 400, exchangeFeeCents: 0 } };
    const fees = feesForCountry(isolated, "ES");
    expect(fees.returnFeeCents).toBe(400);
    // The actual regression guard is `npx tsc --noEmit`, not this runtime
    // assertion: if `readonly` is ever removed from `CountryFees`, this
    // assignment stops being a type error, the directive below becomes
    // unused, and tsc fails with "Unused '@ts-expect-error' directive".
    // @ts-expect-error readonly: mutating a cached fee row must not compile
    fees.returnFeeCents = 0;
  });
});

describe("resolveFee — Rule A, by net amount", () => {
  const es = TABLE.ES;

  it("charges nothing for an empty basket", () => {
    expect(resolveFee(es, { hasItems: false, netAmount: 0 })).toEqual({
      feeCents: 0,
      kind: "none",
    });
  });

  it("charges the return fee when money flows back to the customer", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: 42.5 })).toEqual({
      feeCents: 400,
      kind: "return",
    });
  });

  it("charges the exchange fee when the customer owes money", () => {
    expect(resolveFee(es, { hasItems: true, netAmount: -12 })).toEqual({
      feeCents: 0,
      kind: "exchange",
    });
  });

  it("charges the exchange fee on an even swap", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 0 })).toEqual({
      feeCents: 600,
      kind: "exchange",
    });
  });

  // The divergence that made summary.tsx and the Stripe amount disagree:
  // a pure exchange for a CHEAPER item leaves netAmount > 0, so Rule A
  // charges the return fee. Rule B charged the exchange fee here.
  it("charges the return fee on an exchange for a cheaper item", () => {
    expect(resolveFee(TABLE.FR, { hasItems: true, netAmount: 5 })).toEqual({
      feeCents: 900,
      kind: "return",
    });
  });

  it("ignores netAmount entirely when the basket is empty", () => {
    expect(resolveFee(TABLE.FR, { hasItems: false, netAmount: 99 })).toEqual({
      feeCents: 0,
      kind: "none",
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
