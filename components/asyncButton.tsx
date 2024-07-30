"use client";
import { updateFinalOrder } from "@/actions/updateOrder";
import { cn } from "@/lib/utils";

export const AsyncButton = ({ text, id }: { text: string; id: string }) => {
  return (
    <button
      className={cn(
        "bg-slate-300 py-4 rounded-full hover:bg-blue-400 focus:bg-blue-400 flex items-center justify-center w-full"
      )}
      type="submit"
      onClick={async () => {
        updateFinalOrder(id);
      }}
    >
      {text}
    </button>
  );
};
