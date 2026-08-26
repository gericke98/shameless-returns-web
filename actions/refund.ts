"use server";

import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/requireAdmin";
import { settleReturnLine } from "@/lib/settleReturn";

/**
 * The dashboard's settle button.
 *
 * This action mints gift cards and issues refunds, with `product` and `order`
 * supplied by the caller. It is a server action, so being rendered inside
 * /dashboard protects the BUTTON, not this endpoint: middleware matches routes,
 * and an action is not a route. Without this gate an anonymous caller could mint
 * a card of any value. Return silently rather than throwing — the caller ignores
 * the result, and an unauthenticated caller should learn nothing.
 *
 * `status` is unused and kept only because ReturnsTable passes it.
 */
export async function validateReturn(product: any, status: string, order: any) {
  "use server";

  if (!(await isAdmin())) {
    console.error("validateReturn: rejected a call without an admin session");
    return;
  }

  const outcome = await settleReturnLine(product, order);
  if (outcome.settled) revalidatePath("/", "layout");
}
