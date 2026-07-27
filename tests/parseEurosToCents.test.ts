import { describe, expect, it } from "vitest";
import { parseEurosToCents } from "../actions/parseEurosToCents";

// This suite must be importable and runnable without a DATABASE_URL: it
// imports only the pure `parseEurosToCents` helper from
// `actions/parseEurosToCents.ts`, which has no `db` import and is not
// subject to the "use server" export transform that `actions/shippingFees.ts`
// carries.
describe("parseEurosToCents", () => {
  it("parses a whole euro amount", () => {
    expect(parseEurosToCents("12")).toBe(1200);
  });

  it("parses one decimal place", () => {
    expect(parseEurosToCents("12.5")).toBe(1250);
  });

  it("parses two decimal places", () => {
    expect(parseEurosToCents("12.50")).toBe(1250);
  });

  it("accepts a comma decimal separator", () => {
    expect(parseEurosToCents("12,50")).toBe(1250);
  });

  it("allows zero — a genuinely free lane is a legitimate admin choice", () => {
    expect(parseEurosToCents("0")).toBe(0);
    expect(parseEurosToCents("0.00")).toBe(0);
  });

  it("rejects negative amounts", () => {
    expect(parseEurosToCents("-5")).toBeNull();
    expect(parseEurosToCents("-0.01")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseEurosToCents("abc")).toBeNull();
    expect(parseEurosToCents("")).toBeNull();
    expect(parseEurosToCents("   ")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(parseEurosToCents("12.345")).toBeNull();
  });

  it("rejects a bare decimal point with no leading digit", () => {
    expect(parseEurosToCents(".5")).toBeNull();
  });

  it("rejects a trailing decimal point with no digits after it", () => {
    expect(parseEurosToCents("12.")).toBeNull();
  });

  it("rejects NaN-producing input", () => {
    expect(parseEurosToCents("NaN")).toBeNull();
    expect(parseEurosToCents("Infinity")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseEurosToCents("  9.00  ")).toBe(900);
  });

  it("rounds to the nearest cent to avoid float drift", () => {
    expect(parseEurosToCents("4.19")).toBe(419);
  });
});
