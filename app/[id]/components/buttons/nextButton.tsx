"use client";

import { cn } from "@/lib/utils";
import { ContinueButtonProps } from "@/types";
import { useT } from "@/lib/i18n/context";

export const ContinueButton = ({
  position,
  hasChanges,
  onClick,
  isPending,
}: ContinueButtonProps) => {
  const t = useT();

  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold",
        position === 2 && "hidden",
        !hasChanges && "hidden"
      )}
      onClick={onClick}
      disabled={!hasChanges || isPending}
    >
      {isPending ? t.common.processing : t.common.continue}
    </button>
  );
};
