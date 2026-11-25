import "server-only";
// Ops confirms or rejects a self-booked tracking number that could not be
// verified with the carrier (docs/superpowers/plans/2026-11-24-verify-tracking-
// before-pin.md). Until then the number is saved but NOT at Amphora, where it
// would be pinned write-once.
//
// Wrapped by `adminAction` (F1 spec §4). Both act on ONE tracking submission,
// named by its id (orders.tracking_submission_id, new on every submit),
// through ONE conditional UPDATE that also requires it to be unverified. So a
// confirm and a reject racing cannot both act, and a stale screen cannot
// confirm or clear a number the customer submitted after it was rendered.
import { revalidatePath } from "next/cache";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { pinSelfTracking } from "@/lib/pinSelfTracking";
import { readLocale } from "@/lib/i18n";
import { ok, refuse, type HandlerResult } from "@/lib/actionResult";
import type { AdminContext } from "@/lib/server/actions";
import { adminTarget, type VerifiedOrderId } from "@/lib/server/identity";
import { sendSelfTrackingRejected } from "@/lib/server/selfReturnEmails";
import { alertOps } from "@/lib/server/opsAlert";

export const reviewSelfTrackingInput = z
  .object({ orderId: z.string().min(1).max(64), submissionId: z.string().min(1).max(64) })
  .strict();
type ReviewInput = z.infer<typeof reviewSelfTrackingInput>;

const pendingSubmission = (id: VerifiedOrderId, submissionId: string) =>
  and(
    eq(orders.id, id),
    eq(orders.trackingSubmissionId, submissionId),
    eq(orders.returnMethod, "SELF"),
    isNotNull(orders.locator),
    isNull(orders.trackingVerifiedAt)
  );

/** The admin opened the link and the parcel is real: send it to Amphora. */
export async function confirmSelfTrackingHandler(
  ctx: AdminContext,
  input: ReviewInput
): Promise<HandlerResult<{ pinned: boolean }, "not-pending">> {
  const { admin } = ctx;
  const id = adminTarget(input.orderId, ctx);
  const { submissionId } = input;

  const [claimed] = await db
    .update(orders)
    .set({ trackingVerifiedAt: new Date(), trackingVerifiedBy: admin })
    .where(pendingSubmission(id, submissionId))
    .returning({
      id: orders.id,
      orderNumber: orders.orderNumber,
      email: orders.email,
      carrier: orders.carrier,
      locator: orders.locator,
      carrierUrl: orders.carrierUrl,
    });
  if (!claimed) return refuse("not-pending");

  const pinned = await pinSelfTracking({
    id: claimed.id,
    orderNumber: claimed.orderNumber,
    email: claimed.email,
    // Never null on a row with a locator (the orders check constraint).
    carrier: claimed.carrier!,
    number: claimed.locator!,
    carrierUrl: claimed.carrierUrl ?? "",
  });
  revalidatePath("/dashboard");
  return ok({ pinned });
}

/**
 * The number is not a real parcel: clear it, so the portal asks for it again,
 * and email the customer. Amphora was never told, so nothing there changes.
 */
export async function rejectSelfTrackingHandler(
  ctx: AdminContext,
  input: ReviewInput
): Promise<HandlerResult<{}, "not-pending">> {
  const { admin } = ctx;
  const id = adminTarget(input.orderId, ctx);
  const { submissionId } = input;

  // Read first, only so the email can quote the number. The UPDATE decides:
  // it matches only while this submission is still the pending one.
  const current = await db.query.orders.findFirst({
    where: pendingSubmission(id, submissionId),
    columns: { locator: true, orderNumber: true, email: true, shippingName: true, locale: true },
  });
  if (!current?.locator) return refuse("not-pending");

  const cleared = await db
    .update(orders)
    .set({
      locator: null,
      carrier: null,
      carrierUrl: null,
      trackingSubmittedAt: null,
      trackingSubmissionId: null,
      // Stage 2 = "ops has been told about this return's tracking", which is
      // exactly true: ops just handled it and emailed the customer. The sweep
      // must not also remind them or alert ops again (its claim is
      // conditional on the stage it read, so a sweep already in flight
      // cannot write over this either).
      trackingNudgeStage: 2,
    })
    .where(pendingSubmission(id, submissionId))
    .returning({ id: orders.id });
  if (cleared.length === 0) return refuse("not-pending");

  console.log(`[self-tracking] ${admin} rejected ${current.locator} on ${current.orderNumber}`);

  const status = current.email
    ? await sendSelfTrackingRejected(
        current.email,
        current.shippingName ?? "",
        readLocale(current.locale),
        id,
        current.locator
      )
    : 0;
  if (status !== 200) {
    await alertOps(
      `[returns] TRACKING REJECTED, CUSTOMER NOT EMAILED — ${current.orderNumber}`,
      [
        `${admin} rejected tracking ${current.locator} on ${current.orderNumber}.`,
        `The portal now asks for it again, but the email to ${current.email ?? "(no email)"}`,
        `failed (status ${status}). Ask the customer for the correct number by hand.`,
      ].join("\n")
    );
  }
  revalidatePath("/dashboard");
  return ok({});
}
