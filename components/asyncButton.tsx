"use client";
import { updateDashboard, updateFinalOrder } from "@/actions/updateOrder";
import { cn } from "@/lib/utils";

export const AsyncButton = ({ text, id }: { text: string; id: string }) => {
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      onClick={async () => {
        // updateFinalOrder(id); Para más adelante en el dashboard
        updateDashboard(id);
      }}
    >
      {text}
    </button>
  );
};
