import "server-only";
// The capture half of a self-booked return (F1 spec §4 `submitTracking`): the
// customer tells us who they shipped with and the tracking number, and we
// tell the warehouse. Wrapped by `customerAction` in actions/tracking.ts.
//
// The claim is made for an IDENTIFIED self-booked submission
// (`activeSelfSubmission`), never inferred from `orders.return_method`, which
// is written before checkout; and it is one transaction that serializes with
// a cancellation (`claimTracking`).
import { z } from "zod";
import { carrierByCode, checkTrackingNumber, type TrackingNumberProblem } from "@/lib/carriers";
import { checkTrackingUrl } from "@/lib/trackingUrl";
import { verifyWithCarrier } from "@/lib/carrierLookup";
import { pinSelfTracking } from "@/lib/pinSelfTracking";
import { ok, refuse, type HandlerResult } from "@/lib/actionResult";
import type { CustomerContext } from "@/lib/server/actions";
import { alertOps } from "@/lib/server/opsAlert";
import { activeSelfSubmission, claimTracking } from "@/lib/server/submissionScope";

// Transport bounds only, deliberately above the domain limits
// (MAX_TRACKING_NUMBER_LENGTH 64, MAX_TRACKING_URL_LENGTH 512): an over-long
// value is the domain's `too-long` / `invalid-url`, which the portal words.
export const submitTrackingInput = z
  .object({
    expectedOrderId: z.string(),
    carrierCode: z.string().max(64),
    trackingNumber: z.string().max(1000),
    trackingUrl: z.string().max(4000).optional(),
  })
  .strict();

export type TrackingRefusal =
  | "unknown-carrier"
  | "no-active-self-return"
  | TrackingNumberProblem
  | "missing-url"
  | "invalid-url"
  | "not-at-carrier"
  | "already-submitted";

export async function submitTrackingHandler(
  ctx: CustomerContext,
  input: Omit<z.infer<typeof submitTrackingInput>, "expectedOrderId">
): Promise<HandlerResult<{ pending: boolean }, TrackingRefusal>> {
  const id = ctx.orderId;
  const { carrierCode, trackingNumber, trackingUrl } = input;

  const carrier = carrierByCode(carrierCode);
  if (!carrier) return refuse("unknown-carrier");

  // Read fresh (never React's request `cache()`), so a second submit in the
  // same request sees the first one's locator.
  const order = await ctx.order.read();
  const submission = order ? await activeSelfSubmission(id) : null;
  if (!order || !submission) return refuse("no-active-self-return");

  // The same check the portal runs as the customer types (lib/carriers):
  // never a coerced non-string, bounded, not the customer's own order number
  // (#311595, #313127 sent theirs and Amphora pinned it), and one this
  // carrier's link can be built from. Before the write-once claim below, so a
  // refusal writes nothing anywhere and the customer can correct it.
  const checkedNumber = checkTrackingNumber(carrier, trackingNumber, order);
  if (!checkedNumber.ok) return refuse(checkedNumber.reason);
  const number = checkedNumber.number;

  // `carrier_url` is required by Amphora's approve and pinned with the
  // number, write-once. Built by us where we can, so a client cannot replace
  // it; given by the customer, and validated, where we cannot.
  let carrierUrl: string;
  if (checkedNumber.link !== null) {
    carrierUrl = checkedNumber.link;
  } else {
    const checked = checkTrackingUrl(trackingUrl);
    if (!checked.ok) return refuse(checked.reason);
    carrierUrl = checked.url;
  }

  // Idempotency, and the reason it matters more here than anywhere else:
  // Amphora pins `carrier_number` at approve. Re-approving 422s, and
  // cancel-and-recreate hands back the OLD number — so a second submit would
  // desync the warehouse permanently. Stop before Amphora, not after.
  if (order.locator) {
    console.warn(
      `Order ${id}: tracking ${order.locator} already submitted — refusing to replace it.`
    );
    return refuse("already-submitted");
  }

  // A number reaches Amphora (write-once) only once it is verified
  // (docs/superpowers/plans/2026-11-24-verify-tracking-before-pin.md).
  // Asked BEFORE the claim, so a number the carrier says it does not know
  // writes nothing and the customer can correct it (#311595 and #313127 sent
  // their order number; Correos even returns a parcel for "313127" by
  // reference, which the verdict refuses). "unreadable" (timeout, a page we do
  // not recognise) proves nothing either way: it neither refuses the customer
  // nor approves, it goes to ops like a carrier we cannot ask.
  const verdict = carrier.verify ? await verifyWithCarrier(carrier.verify, number) : null;
  if (verdict === "unknown") return refuse("not-at-carrier");
  const verified = verdict === "verified";

  // Written together, and BEFORE Amphora: `carrier` must never be null on a row
  // that has a locator, or `tracksWithCorreos` reads the null as "our own
  // Correos label" and sends a foreign tracking number to localizador.correos.es.
  // The check constraint enforces the same thing at the database.
  //
  // The `if (order.locator)` check above is only a fast-path rejection — it is
  // check-then-act, and two near-simultaneous submits (a double-click that
  // beats the disabled state, a retried POST, two open tabs) can both read
  // `locator` as null before either write lands. If both then reached
  // Amphora, the second call's carrier_number would be rejected as write-once
  // — but if both reached this UPDATE unconditionally, the second write would
  // still overwrite the row, leaving our DB and the dashboard pointing at a
  // carrier Amphora never pinned. That is the exact desync this task exists
  // to prevent, so the database, not this function, must decide who wins:
  // `isNull(orders.locator)` in the WHERE clause means only a row that STILL
  // has no locator gets written, and `.returning()` tells us whether ours was
  // the write that landed. Only the winner may go on to call Amphora, because
  // Amphora's pin cannot be undone.
  //
  // F1: the write is `claimTracking`, one transaction that first locks the
  // identified submission (`FOR UPDATE`) and re-checks it is still accepted
  // and unheld, so a concurrent cancellation either wins first (this is then
  // `no-active-self-return`) or waits for this claim to commit.
  const claimed = await claimTracking(submission, {
    locator: number,
    carrier: carrier.code,
    carrierUrl,
    verifiedBy: verified ? carrier.verify! : null,
  });

  if (!claimed) {
    // Either the slot is taken (a racing submit) or a cancellation took the
    // submission in between. Re-read which, so the customer sees the truth.
    if (!(await activeSelfSubmission(id))) return refuse("no-active-self-return");
    console.warn(
      `Order ${id}: lost the write-once race — another submit already claimed the tracking slot.`
    );
    return refuse("already-submitted");
  }

  if (!verified) {
    // Saved, NOT sent to Amphora: ops opens the link and confirms or rejects
    // it in the dashboard (actions/selfTrackingReview.ts). Pinning an
    // unchecked number is what this whole path exists to stop.
    await alertOps(
      `[returns] SELF TRACKING TO CONFIRM — ${order.orderNumber}`,
      [
        `A customer submitted tracking we could not check with the carrier.`,
        `It is saved but NOT sent to the warehouse until someone confirms it.`,
        ``,
        `Order:     ${order.orderNumber} (id ${id})`,
        `Customer:  ${order.email}`,
        `Carrier:   ${carrier.code}`,
        `Tracking:  ${number}`,
        `Link:      ${carrierUrl}`,
        `Why:       ${verdict === "unreadable" ? `${carrier.code} did not answer our check` : `${carrier.code} cannot be checked automatically`}`,
        ``,
        `Open the link. If the parcel is real, Confirm it in the dashboard;`,
        `otherwise Reject it and the customer is asked for the right number:`,
        `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard`,
      ].join("\n")
    );
    return ok({ pending: true });
  }

  await pinSelfTracking({
    id,
    orderNumber: order.orderNumber,
    email: order.email,
    carrier: carrier.code,
    number,
    carrierUrl,
  });

  return ok({ pending: false });
}
