"use server";

import db from "@/db/drizzle";
import { getOrderQuery } from "@/db/queries";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { orders, productsOrder } from "../db/schema";
import { OrderLineItem } from "@/types";

export async function getOrder(formData: FormData) {
  // Extraigo la informacion del formulario
  const rawFormData = {
    order: formData.get("order"),
    email: formData.get("email"),
  };
  if (rawFormData.order) {
    const order = await getOrderQuery(rawFormData.order.toString());
    // Compruebo si el mail es el mismo (Check de seguridad)
    if (order) {
      if (rawFormData.email?.toString() === order.contact_email) {
        // Extraigo toda la información necesaria y la cargo en tabla propia
        // Use regular expressions to extract exchanged or returned products
        const exchangeRegex = /(\d+\s+x\s+.+?)\s+-\s+EXCHANGE/gi;
        const returnRegex = /(\d+\s+x\s+.+?)\s+-\s+REFUND/gi;
        let exchanges = [];
        let returns = [];

        let match;
        while ((match = exchangeRegex.exec(order.note)) !== null) {
          exchanges.push(match[1].trim());
        }

        while ((match = returnRegex.exec(order.note)) !== null) {
          returns.push(match[1].trim());
        }

        const orderDB = await db.query.orders.findFirst({
          where: eq(orders.id, order.id),
        });
        if (!orderDB && order.id) {
          // Check de si ya se había cambiado con Reveni
          try {
            // Inserto la order en nuestra tabla
            await db.insert(orders).values({
              id: order.id.toString() || "No information provided",
              orderNumber: order.name || "No information provided",
              subtotal: Math.round(Number(order.subtotal_price) * 100) || 0,
              email: order.contact_email || "No information provided",
              shippingName:
                order.shipping_address.name || "No information provided",
              shippingAddress1:
                order.shipping_address.address1 || "No information provided",
              shippingAddress2:
                order.shipping_address.address2 || "No information provided",
              shippingZip:
                order.shipping_address.zip || "No information provided",
              shippingCity:
                order.shipping_address.city || "No information provided",
              shippingProvince:
                order.shipping_address.province || "No information provided",
              shippingCountry:
                order.shipping_address.country || "No information provided",
              shippingPhone:
                order.shipping_address.phone || "No information provided",
            });
            // Inserto cada producto de la order en la otra tabla

            order.line_items.map(async (item: OrderLineItem) => {
              if (item.current_quantity > 0) {
                const wasExchanged = exchanges.some((exchange) =>
                  exchange.includes(item.title)
                );
                const wasReturned = returns.some((returnItem) =>
                  returnItem.includes(item.title)
                );
                const wasChanged = wasExchanged || wasReturned;
                await db.insert(productsOrder).values({
                  lineItemId: item.id.toString() || "No information provided",
                  orderId: order.id.toString() || "No information provided",
                  productId:
                    item.product_id.toString() || "No information provided",
                  title: item.title || "No information provided",
                  variant_title:
                    item.variant_title || "No information provided",
                  variant_id:
                    item.variant_id.toString() || "No information provided",
                  price: item.price || "No information provided",
                  quantity: item.quantity || 0,
                  changed: false,
                  confirmed: wasChanged,
                });
              }
            });
          } catch (e) {
            console.log(e);
            throw new Error("Error while trying to insert values on table");
          }
        }
        redirect(`/${order.id}`);
      } else {
        throw new Error("Invalid credentials");
      }
    }
  }
}
