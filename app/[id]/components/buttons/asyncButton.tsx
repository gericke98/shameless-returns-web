"use client";
import { useTransition } from "react";
import { returnFunction } from "@/actions/return";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/context";
import type { ReturnMethod } from "@/lib/returnMethods";

export const AsyncButton = ({
  text,
  id,
  isCredit,
  email,
  method,
  disabled,
  onPayoutRefused,
}: {
  text: string;
  id: string;
  /** Null when no payout step was shown (nothing comes back to the customer). */
  isCredit: boolean | null;
  email: string;
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

  return (
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
      // `isPending` stays true through the redirect that ends returnFunction,
      // so the button does not flicker back to clickable mid-flight.
      disabled={isPending || disabled}
      aria-busy={isPending}
      onClick={() => {
        if (isPending || disabled) return;
        startTransition(async () => {
          // Success redirects (to Stripe or /success) and never returns here.
          // A refusal for a missing payout comes back as a value, not the
          // crash screen.
          const refusal = await returnFunction(id, isCredit, email, method);
          if (refusal?.reason === "payout-required") onPayoutRefused();
        });
      }}
    >
      {isPending ? t.common.processing : text}
    </button>
  );
};
