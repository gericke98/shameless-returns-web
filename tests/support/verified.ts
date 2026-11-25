// Verified identities for tests (F1). Production code mints these only in
// lib/server/identity.ts (tests/actionBoundary.test.ts, rule 4, which does not
// scan tests/); a test builds the value a real mint would have produced.
import type { AdminTarget, SystemTarget, VerifiedOrderId, VerifiedSubmission } from "@/lib/server/identity";
import type { AdminContext } from "@/lib/server/actions";

export const vid = (id: string | number): VerifiedOrderId => String(id) as VerifiedOrderId;

export const vsub = (orderId: string | number, id: string): VerifiedSubmission =>
  ({ id, orderId: vid(orderId) }) as VerifiedSubmission;

/** The context `customerAction` hands a handler, for calling handlers directly. */
export async function customerCtx(id: string | number) {
  const { orderScope } = await import("@/lib/server/orderScope");
  return { orderId: vid(id), order: orderScope(vid(id)) };
}

/** A scheduled job's capability (F1 spec §11), as `systemTarget(job)` would mint it. */
export const sys = { job: "test" } as SystemTarget;

/** The context `adminAction` hands a handler, as it would mint it from `email`'s session. */
export function adminCtx(email: string): AdminContext {
  const target = { admin: email } as AdminTarget;
  return { target, order: (id: string) => vid(id) };
}
