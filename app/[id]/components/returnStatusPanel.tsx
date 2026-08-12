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
  if (reason === "in-transit") return "blockedInTransit";
  if (reason === "already-settled") return "blockedSettled";
  if (reason === "carrier-unreadable") return "blockedUnreadable";
  return null;
}

type Props = {
  decision: CancelDecision;
  orderId: string;
  locator: string | null;
  carrier: string | null;
};

export function ReturnStatusPanel({ decision, orderId, locator, carrier }: Props) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const cancel = () => {
    startTransition(async () => {
      const result = await cancelReturnFunction(orderId);
      if (result.ok) {
        setDone(true);
        // The order is now a clean slate; re-read the page so the wizard is
        // usable again rather than showing state that no longer exists.
        window.location.reload();
      } else {
        setFailed(true);
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

      {done && <p className="mt-3 font-semibold">{t.cancel.doneTitle}</p>}
      {failed && <p className="mt-3">{t.cancel.failed}</p>}
      {blockedKey && <p className="mt-3">{t.cancel[blockedKey]}</p>}

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
