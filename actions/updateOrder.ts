"use server";

import db from "@/db/drizzle";
import { orders, productsOrder } from "@/db/schema";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import { hasOrderAccess } from "@/lib/orderAccess";
import { ACTIONS } from "@/placeholder";
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
  // The delivery block. Absent for almost every submission — see updateData.
  deliveryName?: string;
  deliveryAddress1?: string;
  deliveryAddress2?: string;
  deliveryZip?: string;
  deliveryCity?: string;
  deliveryProvince?: string;
  // Unlike `country` above, this one IS read from the form. It sets the
  // outbound leg's price, not the carrier lane, and parseDeliveryInput
  // restricts it to SUPPORTED_COUNTRIES.
  deliveryCountry?: string;
  // A hidden marker rendered alongside <DeliveryAddressFields> whenever that
  // block is OFFERED — i.e. whenever the basket contains an exchange — not
  // only when it is ticked. See updateData: this is what tells the write path
  // apart a customer unticking a saved address (marker present, fields
  // absent — clear it) from a pure-return pass that never rendered the block
  // at all (marker absent — leave a previously paid-for address alone).
  deliveryBlockOffered?: string;
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
    deliveryName: formData.get("deliveryName")?.toString(),
    deliveryAddress1: formData.get("deliveryAddress1")?.toString(),
    deliveryAddress2: formData.get("deliveryAddress2")?.toString(),
    deliveryZip: formData.get("deliveryZip")?.toString(),
    deliveryCity: formData.get("deliveryCity")?.toString(),
    deliveryProvince: formData.get("deliveryProvince")?.toString(),
    deliveryCountry: formData.get("deliveryCountry")?.toString(),
    deliveryBlockOffered: formData.get("deliveryBlockOffered")?.toString(),
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

  // The delivery block is validated before anything is written, and a bad one
  // rejects the WHOLE submission rather than being dropped: silently ignoring
  // it would advance the customer to checkout believing their replacement is
  // going somewhere it is not.
  const delivery = parseDeliveryInput(data as Record<string, string | undefined>);
  if (!delivery.ok) {
    console.warn(
      `updateData: rejected the delivery address on order ${data.orderId} (${delivery.reason})`
    );
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
  // <DeliveryAddressFields> is only rendered — offered at all, ticked or not
  // — when the basket contains an exchange (secondWindowForm.tsx). A pure
  // return never renders it and so never submits `deliveryBlockOffered`.
  //
  // Without this gate, `updateData` used to write all seven delivery_*
  // columns unconditionally, nulling them whenever the block was absent from
  // the submission. That is correct for unticking a previously-ticked box
  // (the marker is still present; the fields are not), but it also fired on
  // every later PURE-RETURN pass through this same form — silently wiping a
  // paid-for delivery address days after the customer paid the split fee for
  // it, with no alert and no trace. `position` always restarts at 1, so a
  // customer returning a second garment necessarily walks back through this
  // step.
  //
  // Gating the seven columns on the marker means: block offered + unticked
  // -> marker present, fields absent -> nulls (still clears, as before).
  // Block never offered (pure return) -> marker absent -> columns omitted
  // from the payload entirely, leaving a stored address untouched.
  const deliveryColumns = data.deliveryBlockOffered
    ? {
        // Null when the customer did not ask for a separate address, which
        // also CLEARS a previously stored one — unticking the box has to
        // undo it.
        deliveryName: delivery.value?.name ?? null,
        deliveryAddress1: delivery.value?.address1 ?? null,
        deliveryAddress2: delivery.value?.address2 ?? null,
        deliveryZip: delivery.value?.zip ?? null,
        deliveryCity: delivery.value?.city ?? null,
        deliveryProvince: delivery.value?.province ?? null,
        deliveryCountry: delivery.value?.country ?? null,
      }
    : {};

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
      ...deliveryColumns,
    })
    .where(eq(orders.id, data.orderId));

  revalidatePath("/", "layout");
  return prevState + 1;
}
