"use server";

import { redirect } from "next/navigation";
import { createShippingLabel } from "./shipping";
import { updateFinalOrder } from "./updateOrder";
import { createStripeUrl } from "./payments";
import { getOrderById } from "@/db/queries";
import { createInternationalReturn, isInternationalOrder } from "./amphoraReturn";

/**
 * Route the physical return: Spain → Correos label; international → Amphora
 * collection (gated by AMPHORA_INTL_RETURNS_ENABLED). Returns an HTTP-style
 * status (200 = success) either way.
 */
async function createReturnShipment(id: string): Promise<number> {
  const order = await getOrderById(id);
  const useAmphora =
    !!order &&
    isInternationalOrder(order.shippingCountry) &&
    process.env.AMPHORA_INTL_RETURNS_ENABLED === "true";
  return useAmphora ? createInternationalReturn(id) : createShippingLabel(id);
}

export async function returnFunction(
  id: string,
  isCredit: boolean,
  totalPrice: number,
  email: string
) {
  if (totalPrice < 0) {
    // Caso en el que tiene que pagar el usuario
    const toPay = totalPrice * -1;
    const url = (await createStripeUrl(toPay, email, id, isCredit)).data;
    if (url) {
      redirect(url);
    }
  }
  try {
    // Caso en el que no tiene que pagar nada
    // First update the database
    await updateFinalOrder(id, false, isCredit);
    // // Then create the return shipment (Correos label or Amphora collection)
    const statusLabel = await createReturnShipment(id);
    if (statusLabel !== 200) {
      // If label creation fails, undo database changes
      await updateFinalOrder(id, true, isCredit); // Assuming we add a revert parameter
      console.error("Failed to create shipping label");
    }
  } catch (error) {
    console.error("Error in order processing:", error);
    // Attempt to undo database changes if there was an error
    try {
      await updateFinalOrder(id, true, isCredit);
    } catch (undoError) {
      console.error("Failed to revert database changes:", undoError);
    }
  }
  redirect(`/success`);
}
