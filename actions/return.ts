"use server";

import { redirect } from "next/navigation";
import { createShippingLabel } from "./shipping";
import { updateFinalOrder } from "./updateOrder";
import { createStripeUrl } from "./payments";

export async function returnFunction(
  id: string,
  isCredit: boolean,
  totalPrice: number,
  email: string
) {
  console.log("totalPrice", totalPrice);
  if (totalPrice < 0) {
    // Caso en el que tiene que pagar el usuario
    const toPay = totalPrice * -1;
    const url = (await createStripeUrl(toPay, email)).data;
    if (url) {
      redirect(url);
    }
  }
  try {
    // Paso 0: En caso de necesitar un pago, proceder con el pago
    // // First update the database
    // await updateFinalOrder(id, false, isCredit);
    // // // Then create shipping label and send email
    // const statusLabel = await createShippingLabel(id);
    // if (statusLabel !== 200) {
    //   // If label creation fails, undo database changes
    //   await updateFinalOrder(id, true, isCredit); // Assuming we add a revert parameter
    //   console.error("Failed to create shipping label");
    // }
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
