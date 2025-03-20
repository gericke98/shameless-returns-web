import { cn } from "@/lib/utils";
import { ContinueButtonProps } from "@/types";

export const ContinueButton = ({
  position,
  hasChanges,
  onClick,
  isPending,
}: ContinueButtonProps) => (
  <button
    className={cn(
      "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold",
      position === 2 && "hidden",
      !hasChanges && "hidden"
    )}
    onClick={onClick}
    disabled={!hasChanges || isPending}
  >
    {isPending ? "Processing..." : "Continuar"}
  </button>
);
