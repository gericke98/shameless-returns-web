import { cookies } from "next/headers";
import {
  ORDER_SESSION_COOKIE,
  ORDER_SESSION_TTL_MS,
  readOrderSession,
  signOrderSession,
  verifyOrderSession,
} from "@/lib/orderSession";

// The next/headers layer for the portal session. Deliberately thin: all the
// crypto lives in lib/orderSession.ts, which stays pure and unit-testable.
//
// Server-only — importing next/headers from a client component is a build error.

/**
 * Record that the caller has proven ownership of `orderId`.
 *
 * Called from `actions/order.ts` getOrder, at the point the order number and
 * contact email have already been checked. That check was always there; it just
 * had nowhere to record its result.
 */
export async function issueOrderAccess(orderId: string): Promise<void> {
  const expiresAt = Date.now() + ORDER_SESSION_TTL_MS;

  cookies().set(ORDER_SESSION_COOKIE, signOrderSession(orderId, expiresAt), {
    httpOnly: true,
    // "lax", not "strict": the customer comes back from Stripe Checkout by a
    // top-level cross-site navigation, and "strict" would withhold the cookie
    // on exactly that hop — breaking the paid return flow.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ORDER_SESSION_TTL_MS / 1000,
  });
}

/**
 * Whether the caller has a live, valid session for this specific order.
 *
 * False for every failure — absent, expired, tampered, or issued for a
 * different order. Callers must treat all of those identically so the response
 * never reveals whether an order id names a real order.
 */
export async function hasOrderAccess(orderId: string): Promise<boolean> {
  const value = cookies().get(ORDER_SESSION_COOKIE)?.value;
  return verifyOrderSession(value, orderId, Date.now());
}

/**
 * Which order the caller's session is for, or null if they have none.
 *
 * For the caller that has no candidate id to check — the success page, which
 * must identify the order before it can tell the customer what happened to it.
 * Not a weaker check than `hasOrderAccess`: same signature and expiry
 * verification, it just answers "which" instead of "whether".
 */
export async function currentOrderId(): Promise<string | null> {
  const value = cookies().get(ORDER_SESSION_COOKIE)?.value;
  return readOrderSession(value, Date.now());
}
