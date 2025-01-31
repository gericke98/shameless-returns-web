"use client";
import { returnFunction } from "@/actions/return";
import { cn } from "@/lib/utils";

export const AsyncButton = ({
  text,
  id,
  isCredit,
}: {
  text: string;
  id: string;
  isCredit: boolean;
}) => {
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      onClick={async () => {
        await returnFunction(id, isCredit);
      }}
    >
      {text}
    </button>
  );
};
