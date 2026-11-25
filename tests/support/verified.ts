// Verified identities for tests (F1). Production code mints these only in
// lib/server/identity.ts (tests/actionBoundary.test.ts, rule 4, which does not
// scan tests/); a test builds the value a real mint would have produced.
import type { VerifiedOrderId, VerifiedSubmission } from "@/lib/server/identity";

export const vid = (id: string | number): VerifiedOrderId => String(id) as VerifiedOrderId;

export const vsub = (orderId: string | number, id: string): VerifiedSubmission =>
  ({ id, orderId: vid(orderId) }) as VerifiedSubmission;

/** The context `customerAction` hands a handler, for calling handlers directly. */
export async function customerCtx(id: string | number) {
  const { orderScope } = await import("@/lib/server/orderScope");
  return { orderId: vid(id), order: orderScope(vid(id)) };
}
