"use server";

import db from "@/db/drizzle";
import {
  closeReturn,
  createOrder,
  createRefund,
  getOrderById,
  getOrderTotal,
  processGiftCardReturn,
} from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getFeeTable } from "@/db/fees";
import { normalizeCountry } from "@/lib/countries";
import { resolveZone } from "@/lib/zones";
import { centsToEuros, feesForCountry, feesForWeight } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
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
  // Reload the line from the database instead of trusting what the caller sent.
  // `product` arrives as `any` from the dashboard, and two of its fields decide
  // money: `credit` picks gift card over refund, and `price` IS the gift-card
  // value. An admin session should not also be permission to name that number.
  // The caller still supplies the identifiers — those are looked up, not obeyed.
  const trustedLine = await db.query.productsOrder.findFirst({
    where: and(
      eq(productsOrder.orderId, String(order?.id ?? "")),
      eq(productsOrder.variant_id, String(product?.variant_id ?? ""))
    ),
  });
  if (!trustedLine) {
    console.error(
      `validateReturn: no line for order=${order?.id} variant=${product?.variant_id}`
    );
    return;
  }
  if (trustedLine.refunded) {
    // Already settled. Without this, replaying the same call mints a second
    // gift card for the same return.
    console.error(`validateReturn: line ${trustedLine.id} is already refunded`);
    return;
  }

  // For debugging purposes
  let result;
  let result2;
  // Aqui igual puedo poner si el estado es distinto de preregistrado --> Meter aqui modales para avisar ui
  if (true) {
    // En el caso de ser una gift card, se crea una gift card y no reembolso
    if (trustedLine.credit) {
      // Extraigo la info completa del pedido para saber el customer id
      const totalOrder = await getOrderTotal(order.id);
      const customerId = totalOrder.customer.id;

      // Extraigo el valor del gift card (En este caso siempre será return)
      const feeTable = await getFeeTable();
      const dbOrder = await getOrderById(String(order?.id ?? ""));
      const orderFees = feesForCountry(
        feeTable,
        // From the database, not the caller's object: a lower fee here means a
        // larger gift card.
        resolveZone(dbOrder?.shippingCountry, dbOrder?.shippingZip)
      );
      // The band is chosen by the weight of the whole return parcel, not of
      // this one line — the customer ships one box, and the carrier prices
      // that box. A missing basket falls back to the lightest band, which
      // deducts the least and so favours the customer.
      const loaded = await loadBasket(String(order?.id ?? ""));
      const fees = feesForWeight(orderFees, loaded?.basket.grams ?? 0);
      const giftCardValue =
        (Number(trustedLine.price) - centsToEuros(fees.returnFeeCents)) * 1.15;
      const resultGiftCard = await processGiftCardReturn(
        customerId,
        giftCardValue,
        trustedLine.variant_id
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
      // Every exchanged garment on this order ships in ONE parcel.
      //
      // This used to create a Shopify order per dashboard row, so an order with
      // two exchanges produced two orders — two parcels to the same address, two
      // shipping charges, two deliveries for the customer to wait on. The rows
      // are separate in the UI but the shipment is not, so the whole exchange is
      // settled together and clicking the sibling row afterwards is a no-op
      // (its `refunded` flag is already set).
      const exchangeLines = await db.query.productsOrder.findMany({
        where: and(
          eq(productsOrder.orderId, String(order?.id ?? "")),
          eq(productsOrder.action, "CAMBIO"),
          eq(productsOrder.confirmed, true)
        ),
      });
      const pending = exchangeLines.filter(
        (line) => !line.refunded && line.new_variant_id
      );
      if (pending.length === 0) {
        console.error(
          `validateReturn: no pending exchange lines for order ${order?.id}`
        );
        return;
      }

      result = await createOrder(order, pending);
      if (result?.success) {
        await db
          .update(productsOrder)
          .set({ refunded: true })
          .where(
            and(
              eq(productsOrder.orderId, String(order?.id ?? "")),
              inArray(
                productsOrder.id,
                pending.map((line) => line.id)
              )
            )
          );
        // Close each distinct return once, not once per line. Batched returns
        // share a return_id, so closing per line would call returnClose N times
        // on the same return.
        const returnIds = Array.from(
          new Set(pending.map((line) => line.return_id).filter(Boolean))
        );
        for (const returnId of returnIds) {
          result2 = await closeReturn(returnId as string);
        }
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
