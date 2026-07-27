import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

/**
 * Whether the caller holds an admin session.
 *
 * **Every server action that reads or writes admin-only state must call this.**
 * `middleware.ts` matches the ROUTES `/dashboard/:path*` and `/login`, and a
 * server action is not a route — it is an independently addressable HTTP
 * endpoint that anyone who knows its action id can invoke directly, with
 * arguments of their choosing. Rendering a control inside `/dashboard` protects
 * the button, not the endpoint behind it.
 *
 * This lives in its own module rather than being re-derived per action because
 * it was previously re-derived exactly once, in `actions/shippingFees.ts`, and
 * omitted everywhere else — including `validateReturn`, which mints gift cards.
 */
export async function isAdmin(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return session?.user?.role === "admin";
}
