import crypto from "crypto";

// Signing and verifying the portal session.
//
// `actions/order.ts` getOrder proves ownership — order number plus a matching
// contact email — and then redirects to /{order.id}. Before this module it
// issued nothing, so the URL was the credential and every action behind it
// trusted a client-supplied order id. orders.id is the raw Shopify order id:
// numeric, sequential, enumerable. /[id] renders the customer's name, street
// address and phone.
//
// Pure by design: no db, no next/headers, and `now` is a parameter rather than
// a call to Date.now(), so expiry is directly testable. The cookie layer lives
// in lib/orderAccess.ts.

export const ORDER_SESSION_COOKIE = "return_session";

/** Two hours, absolute from issue — not sliding. Long enough for a return
 *  including a detour to Stripe and back; short enough to bound exposure on a
 *  shared browser. Re-verifying costs the customer two fields they already have. */
export const ORDER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

type Payload = { orderId: string; exp: number };

function secret(): string | undefined {
  // Read at call time, not at module scope: importing this module must never
  // throw, or every route that touches it fails at build.
  return process.env.NEXTAUTH_SECRET;
}

function sign(encodedPayload: string, key: string): string {
  return crypto.createHmac("sha256", key).update(encodedPayload).digest("hex");
}

/**
 * Issue a session for one order. The returned value is `<payload>.<signature>`,
 * where the payload is base64url-encoded JSON — **encoded, not encrypted**.
 * Anyone holding the cookie can read it, so never put anything sensitive in it.
 */
export function signOrderSession(orderId: string, expiresAt: number): string {
  const key = secret();
  if (!key) {
    throw new Error(
      "NEXTAUTH_SECRET must be set to sign a portal session — refusing to issue an unsigned one"
    );
  }

  const payload: Payload = { orderId, exp: expiresAt };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, key)}`;
}

/**
 * Whether `value` is a session this server issued, for this exact order, that
 * has not expired. Returns false for every failure — malformed, tampered,
 * wrong order, expired, or no secret configured — and never throws.
 */
export function verifyOrderSession(
  value: string | undefined | null,
  orderId: string,
  now: number
): boolean {
  const key = secret();
  if (!key || !value) return false;

  // Split on the LAST separator so a payload that ever contains one cannot
  // shift the signature boundary.
  const cut = value.lastIndexOf(".");
  if (cut <= 0 || cut === value.length - 1) return false;

  const encoded = value.slice(0, cut);
  const provided = value.slice(cut + 1);

  const expected = sign(encoded, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual THROWS on a length mismatch, so length-check first.
  // Same guard as app/api/return-label/[parcelId]/route.ts.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // Only now is the payload trustworthy enough to parse.
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
  } catch {
    return false;
  }

  if (typeof payload?.orderId !== "string" || typeof payload?.exp !== "number") {
    return false;
  }
  if (payload.exp <= now) return false;

  return payload.orderId === orderId;
}
