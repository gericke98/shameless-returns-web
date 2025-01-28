"use client";
import { createShippingLabel } from "@/actions/shippingLabel";
import { updateFinalOrder } from "@/actions/updateOrder";
import { cn } from "@/lib/utils";

export const AsyncButton = ({ text, id }: { text: string; id: string }) => {
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      onClick={async () => {
        // Creo la etiqueta de Correos
        let statusLabel = await createShippingLabel(id);
        if (statusLabel === 200) {
          updateFinalOrder(id);
        }
      }}
    >
      {text}
    </button>
  );
};
