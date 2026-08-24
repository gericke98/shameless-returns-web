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
}: {
  text: string;
  id: string;
  isCredit: boolean;
  email: string;
  /**
   * The customer's claimed shipping lane, from ReturnMethodChoice. Optional:
   * the server re-derives the real lane via resolveReturnMethod and ignores
   * any claim that is not exactly "SELF", so an absent value here just means
   * "no self-booking claim" — identical to today's behaviour.
   */
  method?: ReturnMethod;
}) => {
  const t = useT();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      className={cn(
        // Matches ContinueButton — see nextButton.tsx for why the border stays.
        "bg-white text-black border border-black py-4 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold",
        isPending && "opacity-60 cursor-not-allowed"
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
      disabled={isPending}
      aria-busy={isPending}
      onClick={() => {
        if (isPending) return;
        startTransition(async () => {
          await returnFunction(id, isCredit, email, method);
        });
      }}
    >
      {isPending ? t.common.processing : text}
    </button>
  );
};
