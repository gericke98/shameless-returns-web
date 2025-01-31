"use server";

import db from "@/db/drizzle";
import {
  createGiftCard,
  createReturn,
  getFulfillmentLineItems,
  getOrderProductsById,
  getOrderTotal,
} from "@/db/queries";
import { orders, productsOrder } from "@/db/schema";
import { eq } from "drizzle-orm";
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

interface LineItem {
  variant_id: string | number;
  price: string;
  discount_allocations: any[];
}

interface FulfillmentLineItem {
  node: {
    id: string;
    lineItem: {
      variant: {
        id: string;
      };
    };
  };
}

interface OrderData {
  id: string;
  customer: {
    id: string;
  };
  fulfillments: Array<{
    admin_graphql_api_id: string;
    line_items: LineItem[];
  }>;
  line_items: LineItem[];
}

async function processProductReturn(
  product: { action?: string; variant_id: string; [key: string]: any },
  totalOrder: OrderData,
  isCredit: boolean
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

    // result = await processGiftCardReturn(
    //   totalOrder,
    //   lineitem,
    //   fulfillmentsProduct,
    //   adjustedProduct,
    //   product.variant_id
    // );
    // Creo la return

    result = await createReturn(
      totalOrder.id,
      fulfillmentsProduct.node.id,
      adjustedProduct,
      lineitem.discount_allocations[0]
    );

    console.log("result", result);

    // Si la return se creo correctamente, actualizo el producto
    if (result?.success) {
      await db
        .update(productsOrder)
        .set({
          confirmed: true,
          return_id: result.data.id,
          return_line_item_id: result.data.returnLineItems.nodes[0].id,
        })
        .where(eq(productsOrder.variant_id, product.variant_id.toString()));
      if (isCredit) {
        await db
          .update(productsOrder)
          .set({ credit: true })
          .where(eq(productsOrder.variant_id, product.variant_id.toString()));
      }

      revalidatePath("/", "layout");
    }
  } catch (error) {
    console.error("Error processing product return:", error);
    throw error;
  }
}

async function processGiftCardReturn(
  totalOrder: OrderData,
  lineitem: LineItem,
  fulfillmentsProduct: FulfillmentLineItem,
  adjustedProduct: any,
  variantId: string
) {
  const price = Number(lineitem.price);
  const increasedPrice = price * 1.15;
  adjustedProduct.price = increasedPrice.toString();

  const giftCardResult = await createGiftCard(
    totalOrder.customer.id,
    increasedPrice
  );

  if (!giftCardResult.success) {
    throw new Error("Failed to create gift card");
  }

  const result = await createReturn(
    totalOrder.id,
    fulfillmentsProduct.node.id,
    adjustedProduct,
    lineitem.discount_allocations[0]
  );

  if (result?.success) {
    await db
      .update(productsOrder)
      .set({
        credit: true,
        gift_card_id: giftCardResult.data.id,
      })
      .where(eq(productsOrder.variant_id, variantId.toString()));
  }

  return result;
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
    products.map((product) =>
      processProductReturn(
        { ...product, action: product.action || undefined },
        totalOrder,
        isCredit
      )
    )
  );
}
