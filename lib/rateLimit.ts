// Rate-limit policy for the order lookup.
//
// Since /[id] began requiring a portal session, `actions/order.ts` getOrder is
// the only door into the returns portal. It takes an order number plus a
// matching contact email — so someone who knows a customer's email (a breach, or
// simply knowing them) could brute-force sequential Shopify order numbers.
//
// This is defence in depth layered on top of the email match, not the primary
// control. It therefore FAILS OPEN: if the counter cannot be read, the lookup
// proceeds. A database blip must never lock every customer out of returns.
//
// Pure module — no db, no next/headers — so the policy is unit-testable.

/** Failed attempts from one caller within the window before blocking. */
export const LOOKUP_MAX_FAILURES = 10;

/** Rolling window, and also how long a blocked caller stays blocked. */
export const LOOKUP_WINDOW_MS = 15 * 60 * 1000;

/** An IP longer than this is not a real address; refuse to make it a DB key. */
const MAX_IP_LENGTH = 64;

/** The instant the current window opened — the lower bound for counting. */
export function windowStart(now: number): Date {
  return new Date(now - LOOKUP_WINDOW_MS);
}

/**
 * Whether this many recent failures should block further attempts.
 *
 * A negative or NaN count means the count could not be established, and returns
 * false — see the fail-open note above.
 */
export function exceedsLookupLimit(recentFailures: number): boolean {
  if (!Number.isFinite(recentFailures) || recentFailures < 0) return false;
  return recentFailures >= LOOKUP_MAX_FAILURES;
}

/**
 * Best-effort caller identity from request headers.
 *
 * Order is deliberate. `x-real-ip` and `x-vercel-forwarded-for` are set by the
 * platform and cannot be forged by a client. `x-forwarded-for` CAN be prepended
 * to by the caller, so it is the last resort and only its leftmost entry is
 * used. Anyone able to spoof a trusted header defeats this limit — which is why
 * the email match, not this, remains the real control.
 *
 * Returns null when the caller cannot be attributed. Callers must then ALLOW the
 * attempt: bucketing every unattributable request together would let one
 * attacker lock out everybody who shares that fate.
 */
export function clientIpFrom(
  headers: Record<string, string | null | undefined>
): string | null {
  const candidates = [
    headers["x-real-ip"],
    headers["x-vercel-forwarded-for"],
    headers["x-forwarded-for"]?.split(",")[0],
  ];

  for (const candidate of candidates) {
    const ip = candidate?.trim();
    if (ip && ip.length <= MAX_IP_LENGTH) return ip;
  }
  return null;
}
