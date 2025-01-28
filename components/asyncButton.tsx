"use client";
import { createShippingLabel } from "@/actions/shippingLabel";
import { updateFinalOrder } from "@/actions/updateOrder";
import { cn } from "@/lib/utils";

export const AsyncButton = ({
  text,
  id,
  isCredit,
}: {
  text: string;
  id: string;
  isCredit: boolean | null;
}) => {
  return (
    <button
      className={cn(
        "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      )}
      type="submit"
      onClick={async () => {
        try {
          // First update the database
          await updateFinalOrder(id);

          // Then create shipping label and send email
          const statusLabel = await createShippingLabel(id);

          if (statusLabel !== 200) {
            // If label creation fails, undo database changes
            await updateFinalOrder(id, true); // Assuming we add a revert parameter
            console.error("Failed to create shipping label");
          }
        } catch (error) {
          console.error("Error in order processing:", error);
          // Attempt to undo database changes if there was an error
          try {
            await updateFinalOrder(id, true);
          } catch (undoError) {
            console.error("Failed to revert database changes:", undoError);
          }
        }
      }}
    >
      {text}
    </button>
  );
};
