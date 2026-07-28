import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ORDER_SESSION_TTL_MS,
  signOrderSession,
  verifyOrderSession,
} from "@/lib/orderSession";

// The portal session is the only thing standing between a guessed order id and
// a customer's name, street address and phone — orders.id is the raw Shopify
// order id, so it is sequential and enumerable. These tests pin the crypto.

const SECRET = "test-secret-do-not-use-in-production";
const NOW = 1_800_000_000_000;
const ORDER = "5678901234";

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
});

afterEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
});

describe("signOrderSession / verifyOrderSession", () => {
  it("verifies a session for the order it was issued for", () => {
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    expect(verifyOrderSession(token, ORDER, NOW)).toBe(true);
  });

  it("does not verify for a different order id", () => {
    // The whole point: holding a session for your own order must not grant
    // access to somebody else's.
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    expect(verifyOrderSession(token, "9999999999", NOW)).toBe(false);
  });

  it("verifies one millisecond before expiry and not one millisecond after", () => {
    const token = signOrderSession(ORDER, NOW + 1000);
    expect(verifyOrderSession(token, ORDER, NOW + 999)).toBe(true);
    expect(verifyOrderSession(token, ORDER, NOW + 1000)).toBe(false);
    expect(verifyOrderSession(token, ORDER, NOW + 1001)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    const [payload, sig] = token.split(".");
    const flipped = (payload[0] === "a" ? "b" : "a") + payload.slice(1);
    expect(verifyOrderSession(`${flipped}.${sig}`, ORDER, NOW)).toBe(false);
  });

  it("rejects a tampered signature of the correct length", () => {
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    const [payload, sig] = token.split(".");
    const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(flipped).toHaveLength(sig.length);
    expect(verifyOrderSession(`${payload}.${flipped}`, ORDER, NOW)).toBe(false);
  });

  it("returns false rather than throwing on a wrong-length signature", () => {
    // crypto.timingSafeEqual THROWS when the buffers differ in length. Without
    // a length check first this is a 500, not a rejection.
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    const [payload] = token.split(".");
    expect(() => verifyOrderSession(`${payload}.abc`, ORDER, NOW)).not.toThrow();
    expect(verifyOrderSession(`${payload}.abc`, ORDER, NOW)).toBe(false);
    expect(verifyOrderSession(`${payload}.`, ORDER, NOW)).toBe(false);
  });

  it("rejects malformed and absent values", () => {
    for (const value of [undefined, "", "   ", "no-separator", ".", "..", "a.b.c"]) {
      expect(verifyOrderSession(value, ORDER, NOW)).toBe(false);
    }
  });

  it("rejects a session signed with a different secret", () => {
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    process.env.NEXTAUTH_SECRET = "a-different-secret";
    expect(verifyOrderSession(token, ORDER, NOW)).toBe(false);
  });

  it("throws when signing without a secret, rather than signing with nothing", () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(() => signOrderSession(ORDER, NOW + 1000)).toThrow(/NEXTAUTH_SECRET/);
  });

  it("does not verify anything when the secret is unset", () => {
    const token = signOrderSession(ORDER, NOW + ORDER_SESSION_TTL_MS);
    delete process.env.NEXTAUTH_SECRET;
    expect(verifyOrderSession(token, ORDER, NOW)).toBe(false);
  });

  it("encodes rather than encrypts — never put a secret in the payload", () => {
    // Pinned deliberately: the payload is readable by anyone holding the
    // cookie. This test exists so that a future change putting something
    // sensitive in there fails and prompts a rethink.
    const token = signOrderSession(ORDER, NOW + 1000);
    const decoded = Buffer.from(token.split(".")[0], "base64url").toString();
    expect(JSON.parse(decoded)).toEqual({ orderId: ORDER, exp: NOW + 1000 });
  });

  it("ties the signature to the order id, not just to the expiry", () => {
    const a = signOrderSession("1111111111", NOW + 1000);
    const b = signOrderSession("2222222222", NOW + 1000);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
  });

  it("defaults to a two-hour lifetime", () => {
    expect(ORDER_SESSION_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("signOrderSession with an id that is not really a string", () => {
  // This locked every customer out of the portal in production.
  //
  // `db/queries.ts` getOrderQuery returns `await response.json()`, so its
  // result is `any` — TypeScript checks nothing at that boundary. The
  // OrderData type declares `id: string`, but Shopify's Admin REST API sends
  // the order id as a JSON *number*. `actions/order.ts` then handed that
  // number straight to issueOrderAccess.
  //
  // Signing put a number in the payload; verifying compared it against
  // `params.id` from the URL, which is always a string. Every legitimate
  // customer was bounced to the lookup page with "Vuelve a buscar tu pedido
  // para continuar." — and because the gate fails closed and silent by
  // design, it looked identical to an expired session.
  const NUMERIC_ID = 13182814978374;

  it("verifies against the string form of a numeric order id", () => {
    const token = signOrderSession(
      // Exactly what the untyped Shopify boundary hands us.
      NUMERIC_ID as unknown as string,
      NOW + ORDER_SESSION_TTL_MS
    );
    expect(verifyOrderSession(token, String(NUMERIC_ID), NOW)).toBe(true);
  });

  it("puts a string in the payload no matter what it was given", () => {
    const token = signOrderSession(
      NUMERIC_ID as unknown as string,
      NOW + ORDER_SESSION_TTL_MS
    );
    const payload = JSON.parse(
      Buffer.from(token.split(".")[0], "base64url").toString()
    );
    expect(payload.orderId).toBe("13182814978374");
    expect(typeof payload.orderId).toBe("string");
  });

  it("still refuses a session for a different order after coercion", () => {
    // Coercing the type must not blur which order the session is for.
    const token = signOrderSession(
      NUMERIC_ID as unknown as string,
      NOW + ORDER_SESSION_TTL_MS
    );
    expect(verifyOrderSession(token, "13182814978375", NOW)).toBe(false);
    expect(verifyOrderSession(token, "1318281497837", NOW)).toBe(false);
    expect(verifyOrderSession(token, "", NOW)).toBe(false);
  });
});
