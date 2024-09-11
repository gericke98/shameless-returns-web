"use client";
import { cn } from "@/lib/utils";
import BeatLoader from "react-spinners/BeatLoader";
import { useFormStatus } from "react-dom";

export const Button = ({ text }: { text: string }) => {
  const { pending } = useFormStatus();
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      disabled={pending}
    >
      {pending ? <BeatLoader color="white" /> : text}
    </button>
  );
};
