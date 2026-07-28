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
import { hasOrderAccess } from "@/lib/orderAccess";
import { centsToEuros, feesForCountry, feesForWeight } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import { ACTIONS } from "@/placeholder";
import { FulfillmentLineItem, OrderData, OrderLineItem } from "@/types";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

type FormDataFields = {
  orderId?: string;
  parentOrderId?: string;
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
    // NOTE: `orderId` is the productsorder ROW id (the form field is "id").
    // The order it belongs to is `parentOrderId` below — a portal session names
    // an order, so that is what has to be verified.
    orderId: formData.get("id")?.toString(),
    parentOrderId: formData.get("orderId")?.toString(),
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
  // Reject before any DB access. Without this, knowing an order id was enough
  // to alter somebody else's return.
  if (!data.parentOrderId || !(await hasOrderAccess(data.parentOrderId))) {
    return;
  }

  const actionType = data.action === ACTIONS.CHANGE ? "CAMBIO" : "DEVOLUCIÓN";

  if (!data.orderId || !data.oldVariantId) return;

  if (actionType === "CAMBIO" && !data.newSize) return;

  await updateProductOrder(data, actionType);
  revalidatePath("/", "layout");
}

/**
 * Clear the return/exchange selection on ONE order line.
 *
 * Takes the `productsorder` row's own primary key, not a variant id. It used to
 * take the latter and scope the write with `eq(productsOrder.variant_id, ...)`
 * alone — but that column holds the Shopify PRODUCT VARIANT id, which is the
 * same value in every order containing that product in that size. So a single
 * call wiped the in-progress selection of every customer who had bought it, and
 * because this is a server action reachable by anyone and a variant id is public
 * storefront data, it needed no order id at all.
 *
 * Scoping by the row's primary key is the tightest available and matches how the
 * sibling writes in this file are scoped.
 */
export async function anularOrder(productOrderId: number, orderId: string) {
  if (!Number.isInteger(productOrderId) || productOrderId <= 0) return;
  if (!orderId || !(await hasOrderAccess(orderId))) return;

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
    // Scoped by BOTH: a row id alone must not suffice even with a valid session
    // for a different order.
    .where(
      and(eq(productsOrder.id, productOrderId), eq(productsOrder.orderId, orderId))
    );

  revalidatePath("/", "layout");
}

export async function updateData(prevState: number, formData: FormData) {
  const data = parseFormData(formData);

  // Unlike updateOrder's form, this one submits the ORDER id as "id" (see
  // secondWindowForm), so data.orderId is what the session names. This action
  // rewrites the shipping address, which redirects where the return label is
  // sent — the most consequential customer-facing write on the portal.
  if (!data.orderId || !(await hasOrderAccess(data.orderId))) {
    return prevState;
  }

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

/**
 * NOT session-gated, deliberately.
 *
 * Reached from two callers: `returnFunction` (a customer with a portal session)
 * and the Stripe webhook (`app/api/webhooks/stripe/route.ts`), which is an
 * inbound request from Stripe with NO cookies, authenticated by signature
 * verification instead.
 *
 * Adding a portal-session check here would break every PAID return: the payment
 * would succeed and the return would never be created. The gate belongs on the
 * customer entry points — see docs/superpowers/specs/2026-07-27-portal-session-design.md
 */
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
  // One parcel, one weight: the band comes from the whole return, not from
  // any single product in it.
  const loadedForWeight = await loadBasket(id);
  const returnFeeEuros = centsToEuros(
    feesForWeight(orderFees, loadedForWeight?.basket.grams ?? 0).returnFeeCents
  );
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
