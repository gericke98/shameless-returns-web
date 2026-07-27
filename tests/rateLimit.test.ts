import { describe, expect, it } from "vitest";
import {
  LOOKUP_MAX_FAILURES,
  LOOKUP_WINDOW_MS,
  clientIpFrom,
  exceedsLookupLimit,
  windowStart,
} from "@/lib/rateLimit";

// The order lookup is the only door into the returns portal now that /[id]
// requires a session. It takes an order number and a matching contact email —
// so an attacker who knows a customer's email can brute-force sequential
// Shopify order numbers. These tests pin the policy.

describe("exceedsLookupLimit", () => {
  it("allows attempts below the ceiling", () => {
    expect(exceedsLookupLimit(0)).toBe(false);
    expect(exceedsLookupLimit(LOOKUP_MAX_FAILURES - 1)).toBe(false);
  });

  it("blocks at the ceiling and above", () => {
    expect(exceedsLookupLimit(LOOKUP_MAX_FAILURES)).toBe(true);
    expect(exceedsLookupLimit(LOOKUP_MAX_FAILURES + 50)).toBe(true);
  });

  it("uses a ten-failure ceiling over fifteen minutes", () => {
    // Pinned so a future loosening is a deliberate, visible change.
    expect(LOOKUP_MAX_FAILURES).toBe(10);
    expect(LOOKUP_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it("treats a negative or nonsense count as not exceeding", () => {
    // A failed count query must fail OPEN — a database blip cannot be allowed
    // to lock every customer out of returns.
    expect(exceedsLookupLimit(-1)).toBe(false);
    expect(exceedsLookupLimit(NaN)).toBe(false);
  });
});

describe("windowStart", () => {
  it("is exactly one window behind now", () => {
    const now = 1_800_000_000_000;
    expect(windowStart(now).getTime()).toBe(now - LOOKUP_WINDOW_MS);
  });
});

describe("clientIpFrom", () => {
  // Ordering matters: x-real-ip and x-vercel-forwarded-for are set by the
  // platform and cannot be forged by a client. x-forwarded-for CAN be prepended
  // to, so it is the last resort and only its LEFTMOST entry is used.
  it("prefers x-real-ip", () => {
    expect(
      clientIpFrom({
        "x-real-ip": "203.0.113.7",
        "x-vercel-forwarded-for": "198.51.100.1",
        "x-forwarded-for": "1.2.3.4",
      })
    ).toBe("203.0.113.7");
  });

  it("falls back to x-vercel-forwarded-for", () => {
    expect(
      clientIpFrom({
        "x-vercel-forwarded-for": "198.51.100.1",
        "x-forwarded-for": "1.2.3.4",
      })
    ).toBe("198.51.100.1");
  });

  it("falls back to the leftmost x-forwarded-for entry", () => {
    expect(clientIpFrom({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" })).toBe(
      "203.0.113.9"
    );
  });

  it("trims whitespace", () => {
    expect(clientIpFrom({ "x-forwarded-for": "  203.0.113.9 , 10.0.0.1" })).toBe(
      "203.0.113.9"
    );
  });

  it("returns null when no header identifies the caller", () => {
    // Null means "cannot attribute", and the caller must then allow the attempt
    // rather than blocking everyone who lands in one unattributable bucket.
    expect(clientIpFrom({})).toBeNull();
    expect(clientIpFrom({ "x-forwarded-for": "" })).toBeNull();
    expect(clientIpFrom({ "x-real-ip": "   " })).toBeNull();
  });

  it("ignores an over-long value rather than storing it", () => {
    // Defensive: the header is attacker-controlled in the fallback case, and
    // this value becomes a database key.
    expect(clientIpFrom({ "x-real-ip": "a".repeat(200) })).toBeNull();
  });
});
