"use server";

// Ops confirms or rejects a self-booked tracking number that could not be
// verified with the carrier (docs/superpowers/plans/2026-11-24-verify-tracking-
// before-pin.md). Until then the number is saved but NOT at Amphora, where it
// would be pinned write-once.
//
// Both actions are public endpoints whatever renders them, so each checks the
// admin session itself. Both decide through ONE conditional UPDATE on
// `tracking_verified_at IS NULL`, so a confirm and a reject racing on the same
// order cannot both act: whichever lands first wins, the other changes nothing.
import { revalidatePath } from "next/cache";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders } from "@/db/schema";
import { adminEmail } from "@/lib/requireAdmin";
import { pinSelfTracking } from "@/lib/pinSelfTracking";
import { readLocale } from "@/lib/i18n";
import { sendSelfTrackingRejected } from "./selfReturnEmails";
import { alertOps } from "./opsAlert";

export type ReviewOutcome =
  | { ok: true; pinned?: boolean }
  | { ok: false; reason: "not-admin" | "not-pending" };

const pendingRow = (id: string) =>
  and(
    eq(orders.id, id),
    eq(orders.returnMethod, "SELF"),
    isNotNull(orders.locator),
    isNull(orders.trackingVerifiedAt)
  );

/** The admin opened the link and the parcel is real: send it to Amphora. */
export async function confirmSelfTracking(id: string): Promise<ReviewOutcome> {
  const admin = await adminEmail();
  if (!admin) return { ok: false, reason: "not-admin" };
  if (typeof id !== "string" || id === "") return { ok: false, reason: "not-pending" };

  const [claimed] = await db
    .update(orders)
    .set({ trackingVerifiedAt: new Date(), trackingVerifiedBy: admin })
    .where(pendingRow(id))
    .returning({
      id: orders.id,
      orderNumber: orders.orderNumber,
      email: orders.email,
      carrier: orders.carrier,
      locator: orders.locator,
      carrierUrl: orders.carrierUrl,
    });
  if (!claimed) return { ok: false, reason: "not-pending" };

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
  return { ok: true, pinned };
}

/**
 * The number is not a real parcel: clear it, so the portal asks for it again,
 * and email the customer. Amphora was never told, so nothing there changes.
 */
export async function rejectSelfTracking(id: string): Promise<ReviewOutcome> {
  const admin = await adminEmail();
  if (!admin) return { ok: false, reason: "not-admin" };
  if (typeof id !== "string" || id === "") return { ok: false, reason: "not-pending" };

  // The number is read first so the email can quote it, and the UPDATE is
  // conditional on that same number: a customer re-submitting in between, or
  // a confirm landing first, makes this match nothing.
  const current = await db.query.orders.findFirst({
    where: pendingRow(id),
    columns: { locator: true, orderNumber: true, email: true, shippingName: true, locale: true },
  });
  if (!current?.locator) return { ok: false, reason: "not-pending" };

  const cleared = await db
    .update(orders)
    .set({
      locator: null,
      carrier: null,
      carrierUrl: null,
      trackingSubmittedAt: null,
      // Ops is already handling this return: the abandonment sweep must not
      // also remind the customer or re-alert ops about it.
      trackingNudgeStage: 2,
    })
    .where(and(pendingRow(id), eq(orders.locator, current.locator)))
    .returning({ id: orders.id });
  if (cleared.length === 0) return { ok: false, reason: "not-pending" };

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
  return { ok: true };
}
