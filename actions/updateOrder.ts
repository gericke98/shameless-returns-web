"use server";

import db from "@/db/drizzle";
import {
  createReturn,
  getFulfillmentLineItems,
  getOrderProductsById,
  getOrderTotal,
} from "@/db/queries";
import { orders, productsOrder } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function updateOrder(formData: FormData) {
  // Extraigo la informacion del form
  const rawFormData = {
    orderId: formData.get("id"),
    action: formData.get("accion"),
    motivo: formData.get("motivo"),
    notas: formData.get("notas"),
    newSize: formData.get("newSize"),
    variantId: formData.get("variantId"),
    oldVariantId: formData.get("oldVariantId"),
  };
  const actionProduct =
    rawFormData.action === "Quiero cambiar este producto"
      ? "CAMBIO"
      : "DEVOLUCIÓN";
  if (rawFormData.orderId && rawFormData.newSize && rawFormData.oldVariantId) {
    // Actualizo la información de los productos
    await db
      .update(productsOrder)
      .set({
        changed: true,
        action: actionProduct,
        reason: rawFormData.motivo?.toString(),
        notes: rawFormData.notas?.toString(),
        new_variant_title: rawFormData.newSize.toString(),
        new_variant_id: rawFormData.variantId?.toString(),
      })
      .where(eq(productsOrder.variant_id, rawFormData.oldVariantId.toString()));
    revalidatePath("/", "layout");
  } else if (
    rawFormData.orderId &&
    rawFormData.action === "Quiero devolver este producto" &&
    rawFormData.oldVariantId
  ) {
    // Actualizo la información de los productos
    await db
      .update(productsOrder)
      .set({
        changed: false,
        action: actionProduct,
        reason: rawFormData.motivo?.toString(),
        notes: rawFormData.notas?.toString(),
        new_variant_title: null,
        new_variant_id: null,
      })
      .where(eq(productsOrder.variant_id, rawFormData.oldVariantId.toString()));
    revalidatePath("/", "layout");
  }
}

export async function anularOrder(oldVariantId: string) {
  if (oldVariantId) {
    // Actualizo la información de los productos
    const result = await db
      .update(productsOrder)
      .set({
        changed: false,
        action: null,
        reason: null,
        notes: null,
        new_variant_title: null,
        new_variant_id: null,
      })
      .where(eq(productsOrder.variant_id, oldVariantId));
    revalidatePath("/", "layout");
  }
}

export async function updateData(prevState: number, formData: FormData) {
  // Extraigo la informacion del form
  const rawFormData = {
    id: formData.get("id"),
    name: formData.get("name"),
    address: formData.get("address"),
    address2: formData.get("address2"),
    zip: formData.get("zip"),
    city: formData.get("city"),
    province: formData.get("province"),
    country: formData.get("country"),
    phone: formData.get("phone"),
  };
  if (rawFormData.id && rawFormData.name && rawFormData.address) {
    // Actualizo la información de envío
    await db
      .update(orders)
      .set({
        shippingName: rawFormData.name?.toString(),
        shippingAddress1: rawFormData.address?.toString(),
        shippingAddress2: rawFormData.address2?.toString(),
        shippingZip: rawFormData.zip?.toString(),
        shippingCity: rawFormData.city?.toString(),
        shippingProvince: rawFormData.province?.toString(),
        shippingCountry: rawFormData.country?.toString(),
        shippingPhone: rawFormData.phone?.toString(),
      })
      .where(eq(orders.id, rawFormData.id.toString()));
    revalidatePath("/", "layout");
    return prevState + 1;
  }
  return prevState;
}

export async function updateFinalOrder(id: string) {
  // Extraigo toda la info de la order
  const totalOrder = await getOrderTotal(id);
  console.log(totalOrder);
  const products = await getOrderProductsById(id);
  // Actualizo cada línea de producto que tenga cambio
  products.map(async (product) => {
    if (product.action) {
      // Extraigo el fulfillement line id del producto id
      const fulfillment = totalOrder.fulfillments.find((f: any) =>
        f.line_items.some(
          (item: any) => Number(item.variant_id) === Number(product.variant_id)
        )
      );

      // Extrago el line item
      const lineitem = totalOrder.line_items.find(
        (item: any) => Number(item.variant_id) === Number(product.variant_id)
      );

      const fulfillmentIdLink = fulfillment.admin_graphql_api_id;

      // Extraigo los fulfillment items ids
      const fulfillmentResponse = await getFulfillmentLineItems(
        fulfillmentIdLink
      );
      const fulfillmentsProduct =
        fulfillmentResponse.data.fulfillmentLineItems.edges.find(
          (e: any) =>
            e.node.lineItem.variant.id ===
            `gid://shopify/ProductVariant/${product.variant_id}`
        );
      const result = await createReturn(
        id,
        fulfillmentsProduct.node.id,
        product,
        lineitem.discount_allocations[0]
      );
      console.log(result);
      if (result.success === true) {
        await db
          .update(productsOrder)
          .set({ confirmed: true, return_id: result.data.id })
          .where(eq(productsOrder.variant_id, product.variant_id.toString()));
        // Aquí estaría bien tener una página de success
        revalidatePath("/", "layout");
      }
    }
  });
  // redirect("/success");
}
