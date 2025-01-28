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

type FormDataFields = {
  orderId?: string;
  action?: string;
  motivo?: string;
  notas?: string;
  newSize?: string;
  variantId?: string;
  oldVariantId?: string;
  name?: string;
  address?: string;
  address2?: string;
  zip?: string;
  city?: string;
  province?: string;
  country?: string;
  phone?: string;
};

function parseFormData(formData: FormData): FormDataFields {
  return {
    orderId: formData.get("id")?.toString(),
    action: formData.get("accion")?.toString(),
    motivo: formData.get("motivo")?.toString(),
    notas: formData.get("notas")?.toString(),
    newSize: formData.get("newSize")?.toString(),
    variantId: formData.get("variantId")?.toString(),
    oldVariantId: formData.get("oldVariantId")?.toString(),
    name: formData.get("name")?.toString(),
    address: formData.get("address")?.toString(),
    address2: formData.get("address2")?.toString(),
    zip: formData.get("zip")?.toString(),
    city: formData.get("city")?.toString(),
    province: formData.get("province")?.toString(),
    country: formData.get("country")?.toString(),
    phone: formData.get("phone")?.toString(),
  };
}

async function updateProductOrder(
  data: FormDataFields,
  actionType: "CAMBIO" | "DEVOLUCIÓN"
) {
  const updates = {
    changed: actionType === "CAMBIO",
    action: actionType,
    reason: data.motivo,
    notes: data.notas,
    new_variant_title: actionType === "CAMBIO" ? data.newSize : null,
    new_variant_id: actionType === "CAMBIO" ? data.variantId : null,
  };

  await db
    .update(productsOrder)
    .set(updates)
    .where(eq(productsOrder.variant_id, data.oldVariantId!));
}

export async function updateOrder(formData: FormData) {
  const data = parseFormData(formData);
  const actionType =
    data.action === "Quiero cambiar este producto" ? "CAMBIO" : "DEVOLUCIÓN";

  if (!data.orderId || !data.oldVariantId) return;

  if (actionType === "CAMBIO" && !data.newSize) return;

  await updateProductOrder(data, actionType);
  revalidatePath("/", "layout");
}

export async function anularOrder(oldVariantId: string) {
  if (!oldVariantId) return;

  await db
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

export async function updateData(prevState: number, formData: FormData) {
  const data = parseFormData(formData);

  if (!data.orderId || !data.name || !data.address) {
    return prevState;
  }

  await db
    .update(orders)
    .set({
      shippingName: data.name,
      shippingAddress1: data.address,
      shippingAddress2: data.address2,
      shippingZip: data.zip,
      shippingCity: data.city,
      shippingProvince: data.province,
      shippingCountry: data.country,
      shippingPhone: data.phone,
    })
    .where(eq(orders.id, data.orderId));

  revalidatePath("/", "layout");
  return prevState + 1;
}

async function processProductReturn(product: any, totalOrder: any) {
  if (!product.action) return;

  const fulfillment = totalOrder.fulfillments.find((f: any) =>
    f.line_items.some(
      (item: any) => Number(item.variant_id) === Number(product.variant_id)
    )
  );

  const lineitem = totalOrder.line_items.find(
    (item: any) => Number(item.variant_id) === Number(product.variant_id)
  );

  const fulfillmentResponse = await getFulfillmentLineItems(
    fulfillment.admin_graphql_api_id
  );

  const fulfillmentsProduct =
    fulfillmentResponse.data.fulfillmentLineItems.edges.find(
      (e: any) =>
        e.node.lineItem.variant.id ===
        `gid://shopify/ProductVariant/${product.variant_id}`
    );

  const result = await createReturn(
    totalOrder.id,
    fulfillmentsProduct.node.id,
    product,
    lineitem.discount_allocations[0]
  );

  if (result.success) {
    await db
      .update(productsOrder)
      .set({ confirmed: true, return_id: result.data.id })
      .where(eq(productsOrder.variant_id, product.variant_id.toString()));

    revalidatePath("/", "layout");
  }
}

export async function updateFinalOrder(id: string, revert: boolean = false) {
  if (revert) {
    const products = await getOrderProductsById(id);
    await Promise.all(
      products.map(async (product) => {
        if (product.confirmed) {
          await db
            .update(productsOrder)
            .set({ confirmed: false, return_id: null })
            .where(eq(productsOrder.variant_id, product.variant_id));
        }
      })
    );
    revalidatePath("/", "layout");
    return;
  }

  const totalOrder = await getOrderTotal(id);
  const products = await getOrderProductsById(id);

  await Promise.all(
    products.map((product) => processProductReturn(product, totalOrder))
  );
}
