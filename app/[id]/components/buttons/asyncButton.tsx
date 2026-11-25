"use client";
import { useState, useTransition } from "react";
import { submitReturn } from "@/actions/return";
import { sharedRefusalKey, useCallAction } from "@/lib/callAction";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/context";
import type { ReturnMethod } from "@/lib/returnMethods";

export const AsyncButton = ({
  text,
  id,
  isCredit,
  method,
  disabled,
  onPayoutRefused,
}: {
  text: string;
  id: string;
  /** Null when no payout step was shown (nothing comes back to the customer). */
  isCredit: boolean | null;
  /**
   * The customer's claimed shipping lane, from ReturnMethodChoice (lifted up
   * to ClientOrder, the lowest common ancestor of the choice and this
   * button). Not trusted as-is: the server re-derives the real lane via
   * resolveReturnMethod and ignores any claim that is not exactly "SELF".
   */
  method: ReturnMethod;
  /**
   * The wizard's canSubmit is false: the terms are not agreed yet (a required
   * payout is missing). The server refuses the same case; this keeps the
   * customer from reaching it.
   */
  disabled: boolean;
  /** The server refused for a missing payout: send the customer to choose one. */
  onPayoutRefused: () => void;
}) => {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const callAction = useCallAction();
  const [message, setMessage] = useState<string | null>(null);

  const button = (
    <button
      className={cn(
        // Matches ContinueButton — see nextButton.tsx for why the border stays.
        "bg-white text-black border border-black py-4 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold",
        (isPending || disabled) && "opacity-60 cursor-not-allowed"
      )}
      type="submit"
      // This submit takes ~8 seconds: a Shopify return, then an Amphora
      // booking, then reading the carrier back. With no feedback the customer
      // concludes nothing happened and clicks again — which is how the
      // duplicate submit on order #310185 was produced. The guards downstream
      // refused it correctly, but the second click should never happen.
      //
      // `isPending` stays true through the navigation that ends a successful
      // submit, so the button does not flicker back to clickable mid-flight.
      disabled={isPending || disabled}
      aria-busy={isPending}
      onClick={() => {
        if (isPending || disabled) return;
        setMessage(null);
        startTransition(async () => {
          const outcome = await callAction(submitReturn, {
            expectedOrderId: id,
            payout: isCredit === null ? null : isCredit ? "credit" : "refund",
            method,
          });
          // No answer: whether the submit happened is unknown, so the crash
          // screen (unchanged until F4 resolves unknown outcomes).
          if (outcome.kind === "unknown") throw outcome.error;
          const { result } = outcome;
          if (result.ok) {
            // Stripe Checkout or /success. A full navigation, so `isPending`
            // has no flicker back to clickable before the page leaves.
            window.location.assign(result.value.navigate);
            await new Promise(() => {});
            return;
          }
          if (result.reason === "payout-required") return onPayoutRefused();
          if (result.reason === "no-session") return;
          if (result.reason === "nothing-selected") return setMessage(t.action.nothingSelected);
          if (result.reason === "submission-in-progress") return setMessage(t.action.submissionInProgress);
          setMessage(t.action[sharedRefusalKey(result.reason) ?? "failed"]);
        });
      }}
    >
      {isPending ? t.common.processing : text}
    </button>
  );
  return message ? (
    <div className="flex flex-col gap-2 w-full">
      {button}
      <p role="alert" className="text-sm text-red-600 text-center">
        {message}
      </p>
    </div>
  ) : (
    button
  );
};
