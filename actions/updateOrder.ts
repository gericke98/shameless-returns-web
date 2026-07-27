"use server";

import db from "@/db/drizzle";
import {
  createReturn,
  getFulfillmentLineItems,
  getOrderById,
  getOrderProductsById,
  getOrderTotal,
} from "@/db/queries";
import { getFeeTable } from "@/db/fees";
import { orders, productsOrder } from "@/db/schema";
import { normalizeCountry } from "@/lib/countries";
import { centsToEuros, feesForCountry } from "@/lib/fees";
import { ACTIONS } from "@/placeholder";
import { FulfillmentLineItem, OrderData, OrderLineItem } from "@/types";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

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
  // No `country`: the destination country is never taken from the form. See
  // updateData below.
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
    phone: formData.get("phone")?.toString(),
  };
}

async function updateProductOrder(
  data: FormDataFields,
  actionType: "CAMBIO" | "DEVOLUCIÓN"
) {
  const updates = {
    changed: actionType === "CAMBIO" ? true : false,
    action: actionType || "DEVOLUCIÓN",
    reason: data.motivo || "",
    notes: data.notas || "",
    new_variant_title: actionType === "CAMBIO" ? data.newSize : null,
    new_variant_id: actionType === "CAMBIO" ? data.variantId : null,
  };

  try {
    await db
      .update(productsOrder)
      .set(updates)
      .where(
        and(
          eq(productsOrder.variant_id, data.oldVariantId!),
          eq(productsOrder.id, parseInt(data.orderId!))
        )
      );
  } catch (error) {
    console.error("Error updating product order:", error);
    throw error;
  }
}

export async function updateOrder(formData: FormData) {
  const data = parseFormData(formData);

  // data.action is the submitted <select> value, which is now the stable code
  // (ACTIONS.CHANGE === "CAMBIO"), never the localized label. Comparing against
  // the constant is what keeps an English exchange from being saved as a return.
  const actionType = data.action === ACTIONS.CHANGE ? "CAMBIO" : "DEVOLUCIÓN";

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

  // NOTE: `shippingCountry` is deliberately absent from this payload.
  //
  // The country decides which carrier books the return (Correos domestically,
  // Amphora internationally) and which `shipping_fees` row is charged, so it is
  // not something the customer may supply. The address form renders it
  // read-only, straight from the stored order, and this action never reads a
  // `country` field — a tampered request simply has no effect on the column.
  //
  // This also removes the failure mode where an order whose stored country was
  // not in SUPPORTED_COUNTRIES had the <select> pre-select España and, on
  // Continue, overwrote the real destination with "ES" — which then booked a
  // domestic label for a foreign address and charged the cheaper ES fee.
  await db
    .update(orders)
    .set({
      shippingName: data.name,
      shippingAddress1: data.address,
      shippingAddress2: data.address2,
      shippingZip: data.zip,
      shippingCity: data.city,
      shippingProvince: data.province,
      shippingPhone: data.phone,
    })
    .where(eq(orders.id, data.orderId));

  revalidatePath("/", "layout");
  return prevState + 1;
}

async function processProductReturn(
  product: { action?: string; variant_id: string; [key: string]: any },
  totalOrder: OrderData,
  isCredit: boolean,
  returnFeeEuros: number
) {
  try {
    if (!product.action) return;

    const fulfillment = totalOrder.fulfillments.find((f) =>
      f.line_items.some(
        (item) => Number(item.variant_id) === Number(product.variant_id)
      )
    );

    if (!fulfillment) {
      throw new Error(`No fulfillment found for variant ${product.variant_id}`);
    }

    const lineitem = totalOrder.line_items.find(
      (item) => Number(item.variant_id) === Number(product.variant_id)
    );

    if (!lineitem) {
      throw new Error(`No line item found for variant ${product.variant_id}`);
    }

    const fulfillmentResponse = await getFulfillmentLineItems(
      fulfillment.admin_graphql_api_id
    );

    const fulfillmentsProduct =
      fulfillmentResponse.data.fulfillmentLineItems.edges.find(
        (e: FulfillmentLineItem) =>
          e.node.lineItem.variant.id ===
          `gid://shopify/ProductVariant/${product.variant_id}`
      );

    if (!fulfillmentsProduct) {
      throw new Error(
        `No fulfillment product found for variant ${product.variant_id}`
      );
    }

    const adjustedProduct = { ...product };
    let result;

    // Creo la return
    result = await createReturn(
      totalOrder.id,
      fulfillmentsProduct.node.id,
      adjustedProduct,
      lineitem.discount_allocations?.[0],
      returnFeeEuros
    );

    // Si la return se creo correctamente, actualizo el producto
    if (result?.success) {
      await db
        .update(productsOrder)
        .set({
          confirmed: true,
          return_id: result.data.id,
          return_line_item_id: result.data.returnLineItems.nodes[0].id,
          transaction_id: result.data.transactionId,
          transaction_amount: result.data.transactionAmount,
        })
        .where(
          and(
            eq(productsOrder.variant_id, product.variant_id.toString()),
            eq(productsOrder.orderId, totalOrder.id)
          )
        );
      if (isCredit) {
        await db
          .update(productsOrder)
          .set({ credit: true })
          .where(
            and(
              eq(productsOrder.variant_id, product.variant_id.toString()),
              eq(productsOrder.orderId, totalOrder.id)
            )
          );
      }

      revalidatePath("/", "layout");
    }
  } catch (error) {
    console.error("Error processing product return:", error);
    throw error;
  }
}

export async function updateFinalOrder(
  id: string,
  revert: boolean = false,
  isCredit: boolean
) {
  if (revert) {
    const products = await getOrderProductsById(id);
    await Promise.all(
      products.map(async (product) => {
        if (product.confirmed) {
          await db
            .update(productsOrder)
            .set({ confirmed: false, return_id: null })
            .where(
              and(
                eq(productsOrder.variant_id, product.variant_id),
                eq(productsOrder.orderId, id)
              )
            );
        }
      })
    );
    revalidatePath("/", "layout");
    return;
  }
  const totalOrder = await getOrderTotal(id);
  const products = await getOrderProductsById(id);
  const dbOrder = await getOrderById(id);
  const feeTable = await getFeeTable();
  const orderFees = feesForCountry(
    feeTable,
    normalizeCountry(dbOrder?.shippingCountry)
  );
  const returnFeeEuros = centsToEuros(orderFees.returnFeeCents);
  await Promise.all(
    products.map((product) =>
      processProductReturn(
        { ...product, action: product.action || undefined },
        totalOrder,
        isCredit,
        returnFeeEuros
      )
    )
  );
}
