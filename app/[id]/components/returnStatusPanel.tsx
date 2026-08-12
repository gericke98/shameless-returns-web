"use client";

import { useState, useTransition } from "react";
import { useT } from "@/lib/i18n/context";
import { cancelReturnFunction } from "@/actions/cancelReturn";
import type { CancelBlockedReason, CancelDecision } from "@/lib/cancelEligibility";

/**
 * Which explanation to show for a refusal.
 *
 * Exported and pure so the mapping is testable without rendering. `no-return`
 * has no message because the panel is not rendered at all in that case.
 */
export function blockedMessageKey(
  reason: CancelBlockedReason
): "blockedInTransit" | "blockedSettled" | "blockedUnreadable" | null {
  switch (reason) {
    case "in-transit":
      return "blockedInTransit";
    case "already-settled":
      return "blockedSettled";
    case "carrier-unreadable":
      return "blockedUnreadable";
    case "no-return":
      return null;
    default: {
      // Exhaustiveness guard: if `CancelBlockedReason` ever gains a value,
      // this assignment stops compiling instead of silently falling through
      // to a customer seeing nothing.
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/** The four reasons `blockedMessageKey` knows how to explain. A failed cancel
 *  can also report `"carrier-cancel-failed"` or `"forbidden"`, neither of
 *  which is a `CancelBlockedReason` — those fall back to the generic
 *  `t.cancel.failed` copy instead of being run through this mapping. */
const CANCEL_BLOCKED_REASONS: ReadonlyArray<CancelBlockedReason> = [
  "no-return",
  "already-settled",
  "in-transit",
  "carrier-unreadable",
];

function isCancelBlockedReason(reason: string): reason is CancelBlockedReason {
  return CANCEL_BLOCKED_REASONS.indexOf(reason as CancelBlockedReason) !== -1;
}

type Props = {
  decision: CancelDecision;
  orderId: string;
  locator: string | null;
  carrier: string | null;
};

type FailedKey = "blockedInTransit" | "blockedSettled" | "blockedUnreadable" | "failed";

export function ReturnStatusPanel({ decision, orderId, locator, carrier }: Props) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [failedKey, setFailedKey] = useState<FailedKey | null>(null);
  const [isPending, startTransition] = useTransition();

  const cancel = () => {
    startTransition(async () => {
      // `cancelReturnFunction` returns a value for every outcome it knows
      // about, but it can still REJECT: a dropped connection mid-action, a
      // 60s function timeout, a Next server-action framing error. Without this
      // catch the rejection escaped the transition and neither `done` nor
      // `failedKey` was ever set — the spinner stopped and the customer saw
      // absolutely nothing after clicking a button about their money.
      //
      // The generic message is the only honest one here: a rejection tells us
      // nothing about how far the chain got, so it must not imply either that
      // the return survived or that it was cancelled. `t.cancel.failed` points
      // them at support with their order number, which is the right next step
      // whichever way it went.
      try {
        const result = await cancelReturnFunction(orderId);
        if (result.ok) {
          setDone(true);
          setConfirming(false);
          // No reload here: React 18 batches `setDone(true)` with the state
          // update below it, so a synchronous reload would unload the document
          // before the confirmation ever paints and the customer would see
          // nothing. The customer explicitly asks to leave via the "start a new
          // request" control instead.
        } else {
          // Eligibility can have changed between this page's render and this
          // click (the parcel got scanned, an admin settled it) — when the
          // failure reason is one we have specific copy for, show that instead
          // of the generic "couldn't cancel" message.
          setFailedKey(
            isCancelBlockedReason(result.reason)
              ? blockedMessageKey(result.reason) ?? "failed"
              : "failed"
          );
          setConfirming(false);
        }
      } catch (error) {
        console.error(`Cancel request failed for order ${orderId}:`, error);
        setFailedKey("failed");
        setConfirming(false);
      }
    });
  };

  const blockedKey = decision.cancellable ? null : blockedMessageKey(decision.reason);

  return (
    <div className="w-full rounded-2xl border border-slate-200 p-4 mb-4 text-sm">
      <h2 className="font-semibold mb-2">{t.cancel.heading}</h2>

      {carrier && (
        <p>
          {t.cancel.carrierLabel}: {carrier}
        </p>
      )}
      {locator && (
        <p className="break-all">
          {t.cancel.trackingLabel}: {locator}
        </p>
      )}

      {done && (
        <div className="mt-3">
          <p className="font-semibold">{t.cancel.doneTitle}</p>
          <p>{t.cancel.doneBody}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 underline"
          >
            {t.cancel.startNew}
          </button>
        </div>
      )}
      {failedKey && !done && <p className="mt-3">{t.cancel[failedKey]}</p>}
      {blockedKey && !done && <p className="mt-3">{t.cancel[blockedKey]}</p>}

      {decision.cancellable && !done && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 underline"
        >
          {t.cancel.button}
        </button>
      )}

      {confirming && !done && (
        <div className="mt-3">
          <p className="font-semibold">{t.cancel.confirmQuestion}</p>
          <p>{t.cancel.confirmDetail}</p>
          <div className="mt-2 flex gap-3">
            <button
              type="button"
              onClick={cancel}
              disabled={isPending}
              aria-busy={isPending}
              className="bg-black text-white py-2 px-4 rounded-full disabled:opacity-60"
            >
              {isPending ? t.cancel.cancelling : t.cancel.confirmYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={isPending}
              className="border border-black py-2 px-4 rounded-full"
            >
              {t.cancel.confirmNo}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
