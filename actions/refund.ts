"use server";

import db from "@/db/drizzle";
import {
  closeReturn,
  createOrder,
  createRefund,
  getOrderTotal,
  processGiftCardReturn,
} from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getFeeTable } from "@/db/fees";
import { normalizeCountry } from "@/lib/countries";
import { centsToEuros, feesForCountry } from "@/lib/fees";
import { isAdmin } from "@/lib/requireAdmin";

export async function validateReturn(product: any, status: string, order: any) {
  "use server";

  // This action mints gift cards and issues refunds, with `product` and `order`
  // supplied by the caller — `product.price` feeds the gift-card value directly.
  // It is a server action, so being rendered inside /dashboard protects the
  // button, not this endpoint: middleware matches routes, and an action is not
  // a route. Without this gate an anonymous caller could mint a card of any
  // value. Return silently rather than throwing — the caller ignores the result,
  // and an unauthenticated caller should learn nothing.
  if (!(await isAdmin())) {
    console.error("validateReturn: rejected a call without an admin session");
    return;
  }
  // For debugging purposes
  let result;
  let result2;
  // Aqui igual puedo poner si el estado es distinto de preregistrado --> Meter aqui modales para avisar ui
  if (true) {
    // En el caso de ser una gift card, se crea una gift card y no reembolso
    if (product.credit) {
      // Extraigo la info completa del pedido para saber el customer id
      const totalOrder = await getOrderTotal(order.id);
      const customerId = totalOrder.customer.id;

      // Extraigo el valor del gift card (En este caso siempre será return)
      const feeTable = await getFeeTable();
      const orderFees = feesForCountry(
        feeTable,
        normalizeCountry(order.shippingCountry)
      );
      const giftCardValue =
        (product.price - centsToEuros(orderFees.returnFeeCents)) * 1.15;
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
          .where(
            and(
              eq(productsOrder.variant_id, product.variant_id.toString()),
              eq(productsOrder.orderId, totalOrder.id)
            )
          );
        revalidatePath("/", "layout");
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
        let amountToRefund = Number(product.price) - 5;
        result = await createRefund(
          product.return_id,
          product.return_line_item_id,
          product.transaction_id,
          amountToRefund
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
          .where(
            and(
              eq(productsOrder.variant_id, product.variant_id.toString()),
              eq(productsOrder.orderId, order.id)
            )
          );
        revalidatePath("/", "layout");
      }
    }
  }
}
