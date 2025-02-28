"use server";

import db from "@/db/drizzle";
import {
  closeReturn,
  createOrder,
  createRefund,
  getOrderTotal,
  processGiftCardReturn,
} from "@/db/queries";
import { orders, productsOrder } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function validateReturn(product: any, status: string, order: any) {
  "use server";
  // For debugging purposes
  let result;
  let result2;
  // Aqui igual puedo poner si el estado es distinto de preregistrado --> Meter aqui modales para avisar ui
  if (status === "Entregado") {
    // En el caso de ser una gift card, se crea una gift card y no reembolso
    if (product.credit) {
      // Extraigo la info completa del pedido para saber el customer id
      const totalOrder = await getOrderTotal(order.id);
      const customerId = totalOrder.customer.id;

      // Extraigo el valor del gift card
      const giftCardValue =
        (product.price - Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST)) *
        1.15;
      const resultGiftCard = await processGiftCardReturn(
        customerId,
        giftCardValue,
        product.variant_id
      );
      if (resultGiftCard.success) {
        // Cierro el return
        result2 = await closeReturn(product.return_id);
        await db
          .update(productsOrder)
          .set({
            refunded: true,
          })
          .where(eq(productsOrder.variant_id, product.variant_id.toString()));
      }
    } else if (product.action === "CAMBIO") {
      result = await createOrder(order, product);
      if (result?.success) {
        // Cierro el return
        result2 = await closeReturn(product.return_id);
        await db
          .update(productsOrder)
          .set({
            refunded: true,
          })
          .where(
            and(
              eq(productsOrder.variant_id, product.variant_id.toString()),
              eq(productsOrder.orderId, order.id)
            )
          );
        revalidatePath("/", "layout");
      }
    } else {
      if (product.return_id && product.return_line_item_id) {
        result = await createRefund(
          product.return_id,
          product.return_line_item_id,
          product.transaction_id,
          product.transaction_amount
        );
      }
      if (result?.success) {
        // Cierro el return
        result2 = await closeReturn(product.return_id);
        await db
          .update(productsOrder)
          .set({
            refunded: true,
          })
          .where(eq(productsOrder.variant_id, product.variant_id.toString()));
        revalidatePath("/", "layout");
      }
    }
  }
}
