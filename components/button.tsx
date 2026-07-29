"use client";
import { cn } from "@/lib/utils";
import BeatLoader from "react-spinners/BeatLoader";
import { useFormStatus } from "react-dom";

interface ButtonProps {
  text: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export const Button = ({
  text,
  type = "button",
  disabled,
  className,
  "aria-label": ariaLabel,
}: ButtonProps) => {
  const { pending } = useFormStatus();
  const isDisabled = disabled || pending;

  return (
    <button
      type={type}
      className={cn(
        // Matches ContinueButton — see nextButton.tsx for why the border stays.
        "bg-white text-black border border-black py-4 rounded-full hover:bg-gray-100 focus:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-shameless-orange focus:ring-offset-2 flex items-center justify-center w-full font-bold transition-colors",
        isDisabled && "opacity-50 cursor-not-allowed",
        className
      )}
      disabled={isDisabled}
      aria-label={ariaLabel || text}
      aria-busy={pending}
    >
      {/* black, not white — the button is white now, and a white spinner on it
          would be invisible. */}
      {pending ? <BeatLoader color="black" size={8} margin={4} /> : text}
    </button>
  );
};
