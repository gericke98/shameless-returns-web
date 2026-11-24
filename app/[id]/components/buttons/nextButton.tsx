"use client";

import { cn } from "@/lib/utils";
import { ContinueButtonProps } from "@/types";
import { useT } from "@/lib/i18n/context";

export const ContinueButton = ({
  visible,
  onClick,
  isPending,
}: ContinueButtonProps) => {
  const t = useT();

  return (
    <button
      className={cn(
        // White, per the brand refresh. The border is load-bearing: the card
        // behind this button is the off-white paper texture, so a borderless
        // white button would disappear into it.
        "bg-white text-black border border-black py-4 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold",
        !visible && "hidden"
      )}
      onClick={onClick}
      // Which steps may move on is the wizard's decision (canContinue in
      // lib/portalWizard); hiding is presentation, disabling is the guard.
      disabled={!visible || isPending}
    >
      {isPending ? t.common.processing : t.common.continue}
    </button>
  );
};
