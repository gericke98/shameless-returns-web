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
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 flex items-center justify-center w-full text-white font-bold transition-colors",
        isDisabled && "opacity-50 cursor-not-allowed",
        className
      )}
      disabled={isDisabled}
      aria-label={ariaLabel || text}
      aria-busy={pending}
    >
      {pending ? <BeatLoader color="white" size={8} margin={4} /> : text}
    </button>
  );
};
