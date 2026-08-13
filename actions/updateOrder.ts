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
import { resolveZone } from "@/lib/zones";
import { hasOrderAccess } from "@/lib/orderAccess";
import { centsToEuros, feesForCountry, feesForWeight } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import { ACTIONS } from "@/placeholder";
import {
  releaseExchangeReservation,
  reserveExchangeStock,
} from "./exchangeReservation";
import {
  buildReturnInput,
  matchReturnLineItems,
  presentmentRateFromOrder,
  type ReturnableLine,
} from "@/lib/returnPayload";
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

/**
 * Resolve the Shopify FulfillmentLineItem id for each line the customer is
 * returning. That id is what `returnCreate` needs, and it only exists for goods
 * that were actually fulfilled.
 *
 * A line we cannot resolve is reported and dropped rather than thrown, so one
 * unfulfillable garment no longer costs the customer the rest of their return.
 */
async function resolveFulfillmentLineItems(
  products: Array<{ action?: string; variant_id: string; [key: string]: any }>,
  totalOrder: OrderData
): Promise<ReturnableLine[]> {
  const returnable = products.filter((p) => p.action);
  if (returnable.length === 0) return [];

  // Cache per fulfillment: a multi-line return usually ships in ONE parcel, so
  // this collapses N identical Shopify calls into one.
  const cache = new Map<string, any>();
  const fetchFulfillment = async (gid: string) => {
    if (!cache.has(gid)) cache.set(gid, await getFulfillmentLineItems(gid));
    return cache.get(gid);
  };

  const lines: ReturnableLine[] = [];
  for (const product of returnable) {
    const fulfillment = totalOrder.fulfillments.find((f) =>
      f.line_items.some(
        (item) => Number(item.variant_id) === Number(product.variant_id)
      )
    );
    if (!fulfillment) {
      console.error(
        `No fulfillment found for variant ${product.variant_id} on order ${totalOrder.id} — line skipped`
      );
      continue;
    }

    const response = await fetchFulfillment(fulfillment.admin_graphql_api_id);
    const match = response.data.fulfillmentLineItems.edges.find(
      (e: FulfillmentLineItem) =>
        e.node.lineItem.variant.id ===
        `gid://shopify/ProductVariant/${product.variant_id}`
    );
    if (!match) {
      console.error(
        `No fulfillment line item for variant ${product.variant_id} on order ${totalOrder.id} — line skipped`
      );
      continue;
    }

    lines.push({
      variant_id: String(product.variant_id),
      fulfillmentLineItemId: match.node.id,
      quantity: product.quantity,
      action: product.action,
      reason: product.reason,
      notes: product.notes,
      new_variant_id: product.new_variant_id,
    });
  }

  return lines;
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
    // Deliberately NOT `getOrderProductsById` — that is wrapped in React
    // `cache()`, so a revert following a create in the SAME request would read
    // the rows as they were before the create and decide on stale data. The
    // guard below is only meaningful against what is actually in the table now.
    const products = await db.query.productsOrder.findMany({
      where: eq(productsOrder.orderId, id),
    });
    await Promise.all(
      products.map(async (product) => {
        // A row carrying a `return_id` has a REAL Shopify return behind it, and
        // reverting cannot delete that return — it only blanks our copy of it,
        // which hides a live return from the dashboard (`getReturns` filters on
        // `confirmed`) and leaves the customer with nothing.
        //
        // Order #310957: the customer submitted, the return was created, the
        // request then timed out; she retried, `returnCreate` rejected the
        // second attempt ("Return line item has an invalid quantity" — the units
        // were already on R1), and the catch-all revert wiped the state of the
        // FIRST, successful return. Same reasoning as the post-booking failures
        // in createInternationalReturn / createShippingLabel: once the external
        // thing exists, reverting our side only makes the records lie.
        if (product.return_id) {
          console.error(
            `Order ${id}: refusing to revert variant ${product.variant_id} — it already carries Shopify return ${product.return_id}. Needs manual review, not a revert.`
          );
          return;
        }
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
    // The return is being undone, so the stock hold must go with it —
    // otherwise the replacement garments stay frozen for a return that no
    // longer exists.
    await releaseExchangeReservation(id);
    revalidatePath("/", "layout");
    return;
  }
  const totalOrder = await getOrderTotal(id);
  const products = await getOrderProductsById(id);

  // Idempotency. Reachable twice for one parcel: the customer resubmits after a
  // slow request (or a timeout), or the Stripe webhook is redelivered. Shopify
  // then rejects the second `returnCreate` — the units are already on the first
  // return, so it fails with "Return line item has an invalid quantity" — and
  // the caller's catch-all revert used to undo the first, successful return.
  //
  // Bail out before touching Shopify. The return already exists, which is the
  // outcome the caller wants; creating a second one for the same parcel is the
  // same class of bug as #310756, which was billed the return fee twice.
  const alreadyReturned = products.find((p) => p.return_id);
  if (alreadyReturned) {
    console.warn(
      `Order ${id}: a Shopify return (${alreadyReturned.return_id}) already exists for this parcel — skipping creation (duplicate submit or webhook redelivery).`
    );
    return;
  }

  const dbOrder = await getOrderById(id);
  const feeTable = await getFeeTable();
  const orderFees = feesForCountry(
    feeTable,
    resolveZone(dbOrder?.shippingCountry, dbOrder?.shippingZip)
  );
  // One parcel, one weight: the band comes from the whole return, not from
  // any single product in it.
  const loadedForWeight = await loadBasket(id);
  const returnFeeEuros = centsToEuros(
    feesForWeight(orderFees, loadedForWeight?.basket.grams ?? 0).returnFeeCents
  );

  const lines = await resolveFulfillmentLineItems(
    products.map((p) => ({ ...p, action: p.action || undefined })),
    totalOrder
  );
  if (lines.length === 0) {
    console.error(`No returnable lines for order ${id} — nothing to create`);
    return;
  }

  // ONE return for the whole parcel.
  //
  // This used to be a Promise.all over the products, calling returnCreate once
  // each: order #310756 ended up with returns R1 and R2 for a single box, each
  // carrying the full 5 EUR shipping fee — 10 EUR for one parcel — and the
  // dashboard then minted one exchange order per return.
  //
  // NATIVE_EXCHANGES is off by default. With it off this is today's behaviour
  // minus the duplication; with it on the return also declares what the
  // customer is exchanging FOR, which is what links the replacement to the
  // return in Shopify. See docs — it changes where the warehouse sees the
  // replacement, so it stays dark until Amphora confirms they act on it.
  // The fee is priced in EUR but has to be declared in the currency the
  // customer was shown, taken from the order's own money set. See
  // `presentmentRateFromOrder` — a hardcoded EUR here cost order #310741 its
  // whole return.
  const result = await createReturn(
    buildReturnInput(String(totalOrder.id), lines, returnFeeEuros, {
      includeExchangeItems: process.env.NATIVE_EXCHANGES === "true",
      presentment: presentmentRateFromOrder(totalOrder.total_price_set),
    })
  );

  if (!result.success) {
    throw new Error(
      `returnCreate failed for order ${id}: ${JSON.stringify(
        (result as any).errors ?? (result as any).error
      )}`
    );
  }

  // Matched on the fulfillment line item, never on array position — Shopify
  // makes no promise to echo the input order, and `return_line_item_id` is what
  // `returnRefund` later spends. Pairing by index would refund the wrong
  // garment.
  const returnLineItemByVariant = matchReturnLineItems(
    result.data.returnLineItems,
    lines
  );

  await Promise.all(
    lines.map(async (line) => {
      const returnLineItemId = returnLineItemByVariant[line.variant_id];
      if (!returnLineItemId) {
        // Leave the row unconfirmed rather than store an id we did not receive.
        console.error(
          `Order ${id}: Shopify returned no return line item for variant ${line.variant_id} — row left unconfirmed`
        );
        return;
      }
      await db
        .update(productsOrder)
        .set({
          confirmed: true,
          return_id: result.data.id,
          return_line_item_id: returnLineItemId,
          transaction_id: result.data.transactionId,
          transaction_amount: result.data.transactionAmount,
          ...(isCredit ? { credit: true } : {}),
        })
        .where(
          and(
            eq(productsOrder.variant_id, line.variant_id),
            eq(productsOrder.orderId, String(totalOrder.id))
          )
        );
    })
  );

  // The rows are now confirmed, which is the moment the customer has paid.
  // Hold the replacement stock so their size cannot sell out during the days
  // the parcel spends travelling back. Best-effort by construction — see
  // actions/exchangeReservation.ts.
  await reserveExchangeStock(id);

  revalidatePath("/", "layout");
}
