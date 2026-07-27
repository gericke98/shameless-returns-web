import { describe, expect, it } from "vitest";
import { parseCheckoutMetadata } from "@/lib/checkoutMetadata";

// Stripe metadata is always a string -> string map. actions/payments.ts writes
// `id` as the order id and `isCredit` as the literal "true" or "false".
//
// The bug these tests exist to prevent: the webhook used to read them with
// JSON.parse, which turned "true" into the boolean `true` and then compared it
// against the string "true" — never equal, so isCredit was permanently false
// and a customer who chose store credit silently received a card refund.

describe("parseCheckoutMetadata", () => {
  it("reads isCredit true from the string Stripe actually stores", () => {
    const result = parseCheckoutMetadata({ id: "5678901234", isCredit: "true" });
    expect(result).toEqual({ id: "5678901234", isCredit: true });
  });

  it("reads isCredit false", () => {
    const result = parseCheckoutMetadata({ id: "5678901234", isCredit: "false" });
    expect(result).toEqual({ id: "5678901234", isCredit: false });
  });

  it("keeps the order id a string, matching the text column it queries", () => {
    // JSON.parse("5678901234") returns the number 5678901234, which then flows
    // into eq(orders.id, ...) against a text column and into functions typed
    // for a string. It only worked by driver coercion.
    const result = parseCheckoutMetadata({ id: "5678901234", isCredit: "false" });
    expect(result?.id).toBe("5678901234");
    expect(typeof result?.id).toBe("string");
  });

  it("accepts a non-numeric order id without throwing", () => {
    // JSON.parse would throw outright on this — "Unexpected token 'g'".
    const result = parseCheckoutMetadata({
      id: "gid://shopify/Order/123",
      isCredit: "false",
    });
    expect(result?.id).toBe("gid://shopify/Order/123");
  });

  it('treats any value other than "true" as not credit', () => {
    for (const raw of ["", "TRUE", "1", "yes", "null", "undefined"]) {
      expect(parseCheckoutMetadata({ id: "1", isCredit: raw })?.isCredit).toBe(
        false
      );
    }
  });

  it("returns null when the order id is missing or blank", () => {
    expect(parseCheckoutMetadata({ isCredit: "true" })).toBeNull();
    expect(parseCheckoutMetadata({ id: "", isCredit: "true" })).toBeNull();
    expect(parseCheckoutMetadata({ id: "   ", isCredit: "true" })).toBeNull();
  });

  it("returns null for absent metadata rather than throwing", () => {
    expect(parseCheckoutMetadata(null)).toBeNull();
    expect(parseCheckoutMetadata(undefined)).toBeNull();
  });

  it("defaults isCredit to false when the key is absent", () => {
    expect(parseCheckoutMetadata({ id: "5678901234" })).toEqual({
      id: "5678901234",
      isCredit: false,
    });
  });
});
