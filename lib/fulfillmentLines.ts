// Shopify fulfillment line items: the identity `returnCreate` needs for each
// garment, and how many of it Shopify will still take back.
//
// NOT a "use server" module: every export of one is a callable endpoint, and
// these are internal steps of a submission, gated by their callers.
import { getFulfillmentLineItems } from "@/db/queries";
import type { FulfillmentLineItem, OrderData } from "@/types";

/**
 * Resolve the Shopify FulfillmentLineItem id for each line, by its Shopify
 * line item id — never by variant: an order can carry the same variant on two
 * lines, and matching by variant gave both rows the first line's fulfillment.
 *
 * Returns the rows it resolved; the caller decides what an unresolved one
 * means. Run when the submission is proposed, so the id is part of what the
 * customer agreed to (db/submissions.ts).
 */
export async function resolveFulfillmentLineItems(
  lines: ReadonlyArray<{ productsorderId: number; lineItemId: string }>,
  totalOrder: OrderData
): Promise<Map<number, string>> {
  // Cache per fulfillment: a multi-line return usually ships in ONE parcel, so
  // this collapses N identical Shopify calls into one.
  const cache = new Map<string, any>();
  const fetchFulfillment = async (gid: string) => {
    if (!cache.has(gid)) cache.set(gid, await getFulfillmentLineItems(gid));
    return cache.get(gid);
  };

  const resolved = new Map<number, string>();
  for (const line of lines) {
    const fulfillment = totalOrder.fulfillments.find((f) =>
      f.line_items.some((item) => String(item.id) === String(line.lineItemId))
    );
    if (!fulfillment) continue;

    const response = await fetchFulfillment(fulfillment.admin_graphql_api_id);
    const match = response?.data?.fulfillmentLineItems?.edges?.find(
      (e: FulfillmentLineItem) =>
        e.node.lineItem.id === `gid://shopify/LineItem/${line.lineItemId}`
    );
    if (match) resolved.set(line.productsorderId, match.node.id);
  }
  return resolved;
}

const REFUNDABLE = `
  query RefundableByFulfillmentLineItem($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on FulfillmentLineItem {
        id
        lineItem { id refundableQuantity }
      }
    }
  }
`;

/**
 * How many of each fulfillment line item Shopify will still take back, read
 * live at confirm time. Zero once the line has been refunded — including by a
 * 0.00 refund booked in the admin — and sending a return for it fails the whole
 * mutation (#310828; lib/returnPayload.ts drops it).
 *
 * An id Shopify no longer knows is ABSENT from the map, so the caller can tell
 * "gone" from "nothing left to return".
 */
export async function refundableQuantities(
  fulfillmentLineItemIds: readonly string[]
): Promise<Map<string, number | null>> {
  const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
  if (!token) throw new Error("Missing Shopify access token");
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: REFUNDABLE, variables: { ids: fulfillmentLineItemIds } }),
    }
  );
  const body = await response.json();
  if (body?.errors?.length) {
    throw new Error(`refundableQuantities: ${JSON.stringify(body.errors)}`);
  }
  const found = new Map<string, number | null>();
  for (const node of body?.data?.nodes ?? []) {
    if (node?.id) found.set(node.id, node.lineItem?.refundableQuantity ?? null);
  }
  return found;
}
