"use server";

import db from "@/db/drizzle";
import { getOrderQuery } from "@/db/queries";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { orders, productsOrder } from "../db/schema";
import { OrderLineItem } from "@/types";

export async function getOrder(prevState: any, formData: FormData) {
  const orderNumber = formData.get("order")?.toString();
  const email = formData.get("email")?.toString();

  if (!orderNumber) {
    return { message: "Please enter a valid order number" };
  }

  const cleanOrderNumber = orderNumber.replace(/#/g, "");
  const order = await getOrderQuery(cleanOrderNumber);

  if (!order) {
    return { message: "Please enter a valid order" };
  }

  if (email !== order.contact_email) {
    return { message: "Please enter a valid mail address" };
  }

  if (order.fulfillment_status === null) {
    return {
      message:
        "The order is being prepared. Please contact hello@shamelesscollective.com for any changes",
    };
  }

  if (
    order.fulfillments[0].shipment_status !== "delivered" &&
    !order.fulfillments
  ) {
    return {
      message:
        "The order is still in transit. Please wait until the order is delivered",
    };
  }

  const orderDB = await db.query.orders.findFirst({
    where: eq(orders.id, order.id),
  });

  if (orderDB) {
    return redirect(`/${order.id}`);
  }

  if (!order.id) {
    return { message: "Invalid order ID" };
  }

  // Extract exchanged/returned products from order note
  const exchangeRegex = /(\d+\s+x\s+.+?)\s+-\s+EXCHANGE/gi;
  const returnRegex = /(\d+\s+x\s+.+?)\s+-\s+REFUND/gi;
  const exchanges = Array.from(
    (order.note ?? "").matchAll(
      exchangeRegex
    ) as IterableIterator<RegExpMatchArray>
  ).map((m) => m[1].trim());
  const returns = Array.from(
    (order.note ?? "").matchAll(
      returnRegex
    ) as IterableIterator<RegExpMatchArray>
  ).map((m) => m[1].trim());

  try {
    // Insert order into database
    await db.insert(orders).values({
      id: order.id.toString() || "No information provided",
      orderNumber: order.name || "No information provided",
      subtotal: Math.round(Number(order.subtotal_price) * 100) || 0,
      email: order.contact_email || "No information provided",
      shippingName: order.shipping_address.name || "No information provided",
      shippingAddress1:
        order.shipping_address.address1 || "No information provided",
      shippingAddress2:
        order.shipping_address.address2 || "No information provided",
      shippingZip: order.shipping_address.zip || "No information provided",
      shippingCity: order.shipping_address.city || "No information provided",
      shippingProvince:
        order.shipping_address.province || "No information provided",
      shippingCountry:
        order.shipping_address.country || "No information provided",
      shippingPhone: order.shipping_address.phone || "No information provided",
    });

    // Insert order items
    await Promise.all(
      order.line_items.map(async (item: OrderLineItem) => {
        if (item.quantity <= 0) return;

        const wasExchanged = exchanges.some((exchange) =>
          exchange.includes(item.title)
        );
        const wasReturned = returns.some((returnItem) =>
          returnItem.includes(item.title)
        );
        const wasChanged = wasExchanged || wasReturned;
        const priceWithDiscount =
          Number(item.price) - (item.discount_allocations?.[0]?.amount ?? 0);

        await db.insert(productsOrder).values({
          lineItemId: item.id.toString() || "No information provided",
          orderId: order.id.toString() || "No information provided",
          productId: item.product_id.toString() || "No information provided",
          title: item.title || "No information provided",
          variant_title: item.variant_title || "No information provided",
          variant_id: item.variant_id.toString() || "No information provided",
          price: priceWithDiscount.toString() || "No information provided",
          quantity: item.quantity || 0,
          changed: false,
          confirmed: wasChanged,
          credit: false,
          gift_card_id: null,
        });
      })
    );

    redirect(`/${order.id}`);
  } catch (error) {
    console.log(error);
    return {
      message:
        "Error while trying to connect with database. Please try again later",
    };
  }
}
