"use client";
import { cn } from "@/lib/utils";
import BeatLoader from "react-spinners/BeatLoader";
import { useFormStatus } from "react-dom";

export const Button = ({ text }: { text: string }) => {
  const { pending } = useFormStatus();
  return (
    <button
      className={cn(
        "bg-slate-300 py-4 rounded-full hover:bg-blue-400 focus:bg-blue-400 flex items-center justify-center w-full"
      )}
      type="submit"
      disabled={pending}
    >
      {pending ? <BeatLoader /> : text}
    </button>
  );
};
