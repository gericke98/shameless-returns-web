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
    console.log(order);
    // Compruebo si el mail es el mismo (Check de seguridad)
    if (order) {
      if (rawFormData.email?.toString() === order.contact_email) {
        // Extraigo toda la información necesaria y la cargo en tabla propia
        // Check de si ya existe
        const orderDB = await db.query.orders.findFirst({
          where: eq(orders.id, order.id),
        });
        if (!orderDB && order.id) {
          try {
            // Inserto la order en nuestra tabla
            await db.insert(orders).values({
              id: order.id.toString(),
              orderNumber: order.name,
              subtotal: (Number(order.subtotal_price) * 100).toFixed(0),
              email: order.contact_email,
              shippingName: order.shipping_address.name,
              shippingAddress1: order.shipping_address.address1,
              shippingAddress2: order.shipping_address.address2 && "",
              shippingZip: order.shipping_address.zip,
              shippingCity: order.shipping_address.city,
              shippingProvince: order.shipping_address.province,
              shippingCountry: order.shipping_address.country,
              shippingPhone: order.shipping_address.phone,
            });
            // Inserto cada producto de la order en la otra tabla

            order.line_items.map(async (item: OrderLineItem) => {
              if (item.current_quantity > 0) {
                await db.insert(productsOrder).values({
                  lineItemId: item.id.toString(),
                  orderId: order.id.toString(),
                  productId: item.product_id,
                  title: item.title,
                  variant_title: item.variant_title,
                  variant_id: item.variant_id,
                  price: item.price,
                  quantity: item.quantity,
                  changed: false,
                  confirmed: false,
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
