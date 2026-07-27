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

  it("rejects a thousands-separated comma as if it were a decimal", () => {
    // "1,500" -> comma swapped for a dot -> "1.500", which has three digits
    // after the separator and fails the regex. This pins down that the
    // comma-decimal convenience (see the doc comment) cannot be abused to
    // sneak a thousands grouping past validation and 10x/100x a fee.
    expect(parseEurosToCents("1,500")).toBeNull();
  });

  it("rejects input that passes the digit regex but overflows to Infinity", () => {
    // "NaN"/"Infinity" as literal strings never reach the Number.isFinite
    // guard — they fail the leading \d+ regex first, so a test asserting
    // they're rejected would only be re-testing the non-numeric-input case
    // above. A string of all digits long enough to exceed Number.MAX_VALUE
    // *does* pass the regex and genuinely exercises the isFinite check.
    const tooLarge = "1" + "0".repeat(309); // 10^309 > Number.MAX_VALUE
    expect(parseEurosToCents(tooLarge)).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseEurosToCents("  9.00  ")).toBe(900);
  });

  it("rounds to the nearest cent to avoid float drift", () => {
    expect(parseEurosToCents("4.19")).toBe(419);
  });
});
