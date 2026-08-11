import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORDER_SESSION_COOKIE,
  ORDER_SESSION_TTL_MS,
  signOrderSession,
} from "@/lib/orderSession";

// The next/headers layer over the session. The crypto is pinned in
// tests/orderSession.test.ts; this pins that we read the right cookie and
// refuse to guess when it is absent.

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-production";
  cookieStore.clear();
});

describe("currentOrderId", () => {
  it("returns the order the live session was issued for", async () => {
    const { currentOrderId } = await import("@/lib/orderAccess");
    cookieStore.set(
      ORDER_SESSION_COOKIE,
      signOrderSession("13092191797574", Date.now() + ORDER_SESSION_TTL_MS)
    );

    expect(await currentOrderId()).toBe("13092191797574");
  });

  it("returns null when there is no session cookie", async () => {
    const { currentOrderId } = await import("@/lib/orderAccess");
    expect(await currentOrderId()).toBeNull();
  });

  it("returns null for a session that has expired", async () => {
    // Two-hour TTL, and a slow Stripe checkout can outlive it. The caller must
    // be able to tell "expired" from "failed" — this is what makes that
    // possible.
    const { currentOrderId } = await import("@/lib/orderAccess");
    cookieStore.set(
      ORDER_SESSION_COOKIE,
      signOrderSession("13092191797574", Date.now() - 1)
    );

    expect(await currentOrderId()).toBeNull();
  });

  it("returns null for a forged cookie", async () => {
    const { currentOrderId } = await import("@/lib/orderAccess");
    cookieStore.set(ORDER_SESSION_COOKIE, "not.asession");

    expect(await currentOrderId()).toBeNull();
  });
});
