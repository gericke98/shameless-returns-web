"use server";
import "@shopify/shopify-api/adapters/node";
import { cache } from "react";
import db from "./drizzle";
import { and, desc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { orders, productsOrder, returnLabels } from "./schema";
import { OrderData, OrderLineItem } from "@/types";
import type { ReturnCreateInput } from "@/lib/returnPayload";
import { pickRefundTransaction } from "@/lib/refundTransaction";

const createSession = (): RequestInit => {
  if (
    !process.env.NEXT_PUBLIC_ACCESS_TOKEN ||
    !process.env.NEXT_PUBLIC_SHOP_URL
  ) {
    throw new Error("Missing Shopify access token or shop URL");
  }

  return {
    headers: {
      "X-Shopify-Access-Token": process.env.NEXT_PUBLIC_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  };
};

export const getOrderById = cache(async (id: string) => {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: {
      products: true,
    },
  });
  return order;
});

/**
 * The same read, deliberately NOT wrapped in `cache()`.
 *
 * React's `cache()` dedupes a value for the duration of one render pass, which
 * is right for a page that reads an order from several components. It is wrong
 * for anything long-lived: `/api/cron/amphora-sync` runs over and over on warm,
 * reused serverless instances, and in production it kept reading a snapshot
 * taken before any status had been written —
 *
 *   [amphora-sync][diag] #310905: read returnStatus=null
 *     locator="1Z3EF3229113605089" vs amphora="TRAVELLING"
 *
 * `locator`, written when the return was created, was present; `returnStatus`,
 * written by the first sync, was not. So every run concluded the status had
 * changed and wrote it again. That was harmless only because
 * `collectionScheduled` is disarmed by a stored locator — `returnReceived` is
 * guarded by nothing but that comparison, and would have emailed the customer
 * on every single run once a return reached RECEIVED.
 *
 * Any caller that acts on what it reads — the poller, the status webhook —
 * must use this one.
 */
export async function getOrderByIdFresh(id: string) {
  return db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: {
      products: true,
    },
  });
}

/**
 * Look an order up by its public number ("#310972").
 *
 * Needed by the Amphora status webhook: its payload carries no `external_id`,
 * so when the return id lacks the `SHP ` prefix, the order NAME is the only
 * link back to us.
 */
export const getOrderByNumber = cache(async (orderNumber: string) => {
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNumber, orderNumber),
    with: {
      products: true,
    },
  });
  return order;
});

/** Uncached, for the same reason as `getOrderByIdFresh` — see there. */
export async function getOrderByNumberFresh(orderNumber: string) {
  return db.query.orders.findFirst({
    where: eq(orders.orderNumber, orderNumber),
    with: {
      products: true,
    },
  });
}

/**
 * Self-booked returns still waiting for the customer's tracking number.
 *
 * Deliberately NOT cached — the nudge sweep must see stage changes made by its
 * own previous pass.
 */
export async function getSelfReturnsAwaitingTracking() {
  return db.query.orders.findMany({
    where: and(
      eq(orders.returnMethod, "SELF"),
      isNull(orders.trackingSubmittedAt),
      isNotNull(orders.returnSubmittedAt),
      lt(orders.trackingNudgeStage, 2)
    ),
  });
}

/**
 * Orders with at least one confirmed line still awaiting settlement.
 *
 * Deliberately NOT cached, for the same reason as `getOrderByIdFresh`: the
 * auto-approve cron acts on what it reads and settles in a loop, so a cached
 * read would let it decide twice from one snapshot.
 */
export async function getOrdersWithUnsettledReturns() {
  const rows = await db.query.orders.findMany({
    // Oldest first, so a capped run pays the customers who have waited longest
    // rather than whatever order Postgres happened to hand back.
    //
    // By `id`, NOT by `return_submitted_at`. That column is written in exactly
    // one place — `actions/selfBookedReturn.ts` — so a null stamp does not mean
    // "a row that predates the column", it means "not a self-booked return",
    // which is every Correos and Amphora one. Sorting on it put every customer
    // who paid their own postage permanently last. `orders.id` is the raw
    // Shopify order id, sequential across all lanes, and uniform.
    orderBy: (o, { sql }) => [sql`${o.id} asc`],
    with: { products: { where: eq(productsOrder.confirmed, true) } },
  });
  return rows.filter((order) => order.products.some((p) => !p.refunded));
}

/**
 * Parcels whose journey is still worth watching.
 *
 * A locator to look up, and at least one confirmed line not yet settled — once
 * a return is paid there is nothing left to tell the customer about it.
 *
 * Deliberately NOT cached, for the same reason as `getOrderByIdFresh`: the
 * tracking sweep acts on what it reads and writes back in the same pass.
 *
 * Ordered by `orders.id` — the raw Shopify order id, sequential across every
 * lane — so a capped run reaches the customers who have waited longest and
 * behaves the same on every run. That ordering is oldest-first, so a run
 * truncated by `maxDuration` or by the per-run cap drops the SAME newest
 * parcels every hour. Two things keep that from becoming permanent: the
 * `received` exclusion below bounds the list to parcels that can still produce
 * news, and the route alerts ops when a run truncates.
 */
export async function getParcelsAwaitingTracking() {
  const rows = await db.query.orders.findMany({
    where: and(
      isNotNull(orders.locator),
      // `isNotNull` is not enough: an empty locator is a row with no parcel to
      // ask about, and asking Correos about "" spends a lookup to learn nothing.
      ne(orders.locator, ""),
      // Parcels already at their FINAL milestone can never produce news again,
      // and they are the largest cohort by far — the delivered ones accumulate
      // forever while the live ones are a handful. Leaving them in means the
      // sweep spends its 300-second budget re-reading history.
      or(
        isNull(orders.lastTrackingKey),
        ne(orders.lastTrackingKey, "received")
      )
    ),
    orderBy: (o, { sql }) => [sql`${o.id} asc`],
    with: { products: { where: eq(productsOrder.confirmed, true) } },
  });
  return rows.filter(
    (order) => order.products.length > 0 && order.products.some((p) => !p.refunded)
  );
}

export const getReturns = cache(async () => {
  const returns = await db.query.orders.findMany({
    with: {
      products: {
        where: eq(productsOrder.confirmed, true),
      },
    },
  });
  return returns;
});

export const getOrderProductsById = cache(async (id: string) => {
  const data = await db.query.productsOrder.findMany({
    where: eq(productsOrder.orderId, id),
  });
  return data;
});

export async function getOrderQuery(orderNumber: string) {
  const session = createSession();
  // El %23 es lo mismo que poner #
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/orders.json?query=name:%23${orderNumber}`;

  try {
    const response = await fetch(url, session);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.orders[0];
  } catch (error) {
    console.error("Error fetching orders:", error);
    throw error;
  }
}

export async function getOrderTotal(orderId: string) {
  const session = createSession();
  // El %23 es lo mismo que poner #
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/orders.json?query=id:${orderId}`;

  try {
    const response = await fetch(url, session);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.orders[0];
  } catch (error) {
    console.error("Error fetching orders:", error);
    throw error;
  }
}

/**
 * The transactions of an order, for choosing what a refund is charged against.
 * Null on any failure — the caller stores null, which the refund lane refuses
 * with `no-refund-transaction` and the cron alerts on.
 */
export async function getOrderTransactions(orderId: string) {
  const session = createSession();
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const query = `
    query orderTransactions($id: ID!) {
      order(id: $id) {
        transactions { id kind status amountSet { shopMoney { amount } } }
      }
    }
  `;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { id: `gid://shopify/Order/${orderId}` } }),
    });
    const data = await response.json();
    return data?.data?.order?.transactions ?? null;
  } catch (error) {
    console.error("getOrderTransactions failed:", error);
    return null;
  }
}

/**
 * Create ONE Shopify return for a whole submission.
 *
 * Was called once per line, which gave order #310756 two returns for one
 * parcel and charged the return shipping fee twice. The payload is built by
 * `buildReturnInput` (pure, tested); this function only talks to Shopify.
 *
 * Sent as GraphQL VARIABLES rather than an interpolated document. The previous
 * version pasted the customer's free-text note into the mutation string and
 * relied on JSON.stringify to quote it — correct, but one edit away from an
 * injection into a document that creates returns and moves money.
 */
export async function createReturn(input: ReturnCreateInput) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
      mutation CreateReturn($input: ReturnInput!) {
        returnCreate(returnInput: $input) {
          return {
            id
            name
            returnLineItems(first: 25) {
              nodes {
                id
                ... on ReturnLineItem {
                  fulfillmentLineItem { id }
                }
              }
            }
            exchangeLineItems(first: 25) {
              nodes { id quantity variantId }
            }
            order {
              transactions(first: 10) {
                id
                # Both are load-bearing: without them there is nothing to tell a
                # settled payment from a failed attempt, which is how an
                # unfiltered transactions[0] came to be stored as the refund
                # target. See lib/refundTransaction.ts.
                kind
                status
                amountSet { shopMoney { amount currencyCode } }
              }
            }
          }
          userErrors { field message }
        }
      }
    `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { input } }),
    });

    const data = await response.json();

    if (data.errors || data.data?.returnCreate?.userErrors?.length > 0) {
      console.error(
        "Error creating return:",
        JSON.stringify(data.errors || data.data.returnCreate.userErrors)
      );
      return {
        success: false as const,
        errors: data.errors || data.data?.returnCreate?.userErrors,
      };
    }

    const returnData = data.data.returnCreate.return;
    // The LARGEST SETTLED payment, not `transactions[0]`. A customer whose
    // first attempt failed and who then paid again has the dead attempt first,
    // and storing it strands their refund permanently.
    const transactionData = pickRefundTransaction(returnData.order?.transactions);

    return {
      success: true as const,
      data: {
        id: returnData.id as string,
        name: returnData.name as string,
        returnLineItems: returnData.returnLineItems.nodes,
        exchangeLineItems: returnData.exchangeLineItems.nodes,
        // Null rather than a fallback id. There is no safe second choice here:
        // any other transaction on the order is one Shopify has already told us
        // cannot take a refund.
        transactionId: transactionData?.id ?? null,
        transactionAmount: transactionData?.amountSet?.shopMoney?.amount ?? null,
      },
    };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false as const, error };
  }
}

export async function getFulfillmentLineItems(fulfillmentId: string) {
  const session = createSession(); // Replace with your session creation logic
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
    query FulfillmentShow($id: ID!) {
      fulfillment(id: $id) {
        fulfillmentLineItems(first: 10) {
          edges {
            node {
              id
              lineItem {
                id
                title
                # How many of this line Shopify will still take back. Zero once
                # the line has been refunded — including by a 0.00 refund booked
                # in the admin — and sending a return for it fails the whole
                # mutation. See lib/returnPayload.ts.
                refundableQuantity
                variant {
                  id
                }
              }
              quantity
              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
        status
        estimatedDeliveryAt
        location {
          id
          legacyResourceId
        }
        service {
          handle
        }
        trackingInfo(first: 10) {
          company
          number
          url
        }
        originAddress {
          address1
          address2
          city
          countryCode
          provinceCode
          zip
        }
      }
    }
  `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({
        query,
        variables: {
          id: fulfillmentId,
        },
      }),
    });

    const data = await response.json();

    if (data.errors) {
      console.error("Error fetching fulfillment data:", data.errors);
      return { success: false, errors: data.errors };
    }

    return { success: true, data: data.data.fulfillment };
  } catch (error) {
    console.error("Error:", error);
    return { success: false, error };
  }
}

export async function getProduct(id: string) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/graphql.json`;

  const query = `
    query getProduct($id: ID!) {
      product(id: $id) {
        id
        title
        handle
        description
        images(first: 1) {
          edges {
            node {
              url
              src: url
            }
          }
        }
        variants(first: 50) {
          edges {
            node {
              id
              price
              title
              inventoryQuantity
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/Product/${id}` },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const { data, errors } = await response.json();

    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }

    // Transform the response to include image.src
    const product = data.product;
    if (product.images.edges.length > 0) {
      product.image = {
        src: product.images.edges[0].node.src,
      };
    } else {
      product.image = {
        src: "", // Provide a default empty string if no image exists
      };
    }

    return product;
  } catch (error) {
    console.error("Error fetching product:", error);
    throw error;
  }
}

export async function getVariantsByIds(variantIds: string[]) {
  const uniqueIds = Array.from(new Set(variantIds)).filter(Boolean);
  if (uniqueIds.length === 0) {
    return {};
  }

  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
    query getVariants($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          title
          product {
            title
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({
        query,
        variables: { ids: uniqueIds },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const { data, errors } = await response.json();
    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }

    const variants = data?.nodes ?? [];
    const variantInfoById: Record<
      string,
      { productTitle: string; variantTitle: string }
    > = {};

    for (const node of variants) {
      if (!node?.id || !node?.product?.title) continue;
      variantInfoById[node.id] = {
        productTitle: node.product.title,
        variantTitle: node.title,
      };
    }

    return variantInfoById;
  } catch (error) {
    console.error("Error fetching variants:", error);
    throw error;
  }
}

/**
 * Fetch Shopify variant SKUs by variant id (numeric or GID). Returns a map keyed
 * by the numeric variant id. Amphora's SKU == the Shopify variant SKU (verified),
 * so these are exactly what `createAmphoraReturn` needs.
 */
export async function getVariantSkusByIds(
  variantIds: string[]
): Promise<Record<string, string>> {
  const numericIds = Array.from(new Set(variantIds))
    .map((id) => String(id).replace(/^gid:\/\/shopify\/ProductVariant\//, ""))
    .filter(Boolean);
  if (numericIds.length === 0) return {};

  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const gids = numericIds.map((id) => `gid://shopify/ProductVariant/${id}`);
  const query = `
    query getVariantSkus($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant { id sku }
      }
    }
  `;

  try {
    const skusById: Record<string, string> = {};
    // `nodes` is capped by Shopify's cost limits; 40 keeps us well inside it.
    // The auto-approve cron resolves every pending line of a whole sweep in one
    // call, so this list is a backlog, not a handful.
    for (let i = 0; i < gids.length; i += 40) {
      const response = await fetch(shopifyGraphQLUrl, {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify({ query, variables: { ids: gids.slice(i, i + 40) } }),
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const { data, errors } = await response.json();
      if (errors) {
        console.error("GraphQL Errors:", errors);
        throw new Error("GraphQL query failed");
      }
      for (const node of data?.nodes ?? []) {
        if (!node?.id || !node?.sku) continue;
        const numeric = String(node.id).replace(/^gid:\/\/shopify\/ProductVariant\//, "");
        skusById[numeric] = node.sku;
      }
    }
    return skusById;
  } catch (error) {
    console.error("Error fetching variant SKUs:", error);
    throw error;
  }
}

/**
 * Normalise a Shopify `Weight` to grams.
 *
 * The whole catalogue is currently in GRAMS, but the field carries its own
 * unit and a merchant can change it in the Shopify admin at any time. Reading
 * `value` directly would then silently divide a parcel's weight by 1000 and
 * quietly undercharge every heavy return, so the unit is honoured rather than
 * assumed. An unrecognised unit returns null — the same "unknown" the callers
 * already handle — instead of a wrong number.
 */
function toGrams(weight: { value: number; unit: string } | null | undefined) {
  if (!weight || typeof weight.value !== "number") return null;
  switch (weight.unit) {
    case "GRAMS":
      return weight.value;
    case "KILOGRAMS":
      return weight.value * 1000;
    case "POUNDS":
      return weight.value * 453.59237;
    case "OUNCES":
      return weight.value * 28.349523125;
    default:
      return null;
  }
}

export async function getProducts() {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/graphql.json`;

  const query = `
    query getProducts {
      products(first: 250, query: "status:ACTIVE") {
        edges {
          node {
            id
            title
            handle
            description
            images(first: 1) {
              edges {
                node {
                  url
                  src: url
                }
              }
            }
            variants(first: 50) {
              edges {
                node {
                  id
                  price
                  title
                  inventoryQuantity
                  # Drives the weight band a return is priced in. Lives under
                  # inventoryItem because ProductVariant.weight is deprecated.
                  # Needs the read_inventory scope in addition to
                  # read_products.
                  inventoryItem {
                    measurement {
                      weight {
                        value
                        unit
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({
        query,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const { data, errors } = await response.json();

    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }

    // Transform the response to include image.src for each product
    const products = data.products.edges.map(
      ({ node: product }: { node: any }) => {
        if (product.images.edges.length > 0) {
          product.image = {
            src: product.images.edges[0].node.src,
          };
        } else {
          product.image = {
            src: "", // Provide a default empty string if no image exists
          };
        }
        for (const edge of product.variants?.edges ?? []) {
          edge.node.grams = toGrams(edge.node.inventoryItem?.measurement?.weight);
        }
        return product;
      }
    );

    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

/**
 * Keep the Correos label PDF so it can be sent again.
 *
 * Best-effort by construction: the parcel is already registered by the time
 * this runs, so failing to file the PDF must never fail the return. The cost
 * of losing it is only that a re-send needs a fresh registration — which is
 * exactly the situation this exists to end, but it is not worth a customer's
 * return.
 */
export async function saveReturnLabel(
  orderId: string,
  trackingNumber: string,
  pdfBase64: string
): Promise<void> {
  try {
    await db.insert(returnLabels).values({ orderId, trackingNumber, pdfBase64 });
  } catch (error: any) {
    console.error(
      `Could not store the label PDF for order ${orderId} (${trackingNumber}) — a re-send will need a new registration:`,
      error?.message || error
    );
  }
}

/**
 * The most recently registered label for an order, or null if we hold none.
 *
 * Newest wins: a re-registration supersedes the older parcel, and that is the
 * one whose tracking is on `orders.locator` and in the customer's hands.
 *
 * Null for anything registered before 2026-08-17 — those PDFs were never kept
 * and cannot be recovered from Correos.
 */
export async function getLatestReturnLabel(orderId: string) {
  const [label] = await db
    .select()
    .from(returnLabels)
    .where(eq(returnLabels.orderId, orderId))
    .orderBy(desc(returnLabels.createdAt), desc(returnLabels.id))
    .limit(1);
  return label ?? null;
}

/**
 * Shopify's own view of whether a return is finished.
 *
 * `productsorder.refunded` is written in exactly ONE place — the dashboard
 * button — so any return settled in the Shopify admin instead leaves our flag
 * false forever. Measured 2026-08-25: 52 of 168 unsettled lines were already
 * CLOSED or CANCELED in Shopify. Anything settling automatically must ask
 * Shopify, or it pays those customers twice.
 *
 * A return that cannot be read is ABSENT from the result, never defaulted —
 * `decideAutoApprove` treats absence as ineligible.
 */
export async function getReturnStatusesByIds(
  returnIds: string[]
): Promise<Record<string, string>> {
  const ids = Array.from(new Set(returnIds.filter(Boolean)));
  if (ids.length === 0) return {};

  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const query = `
    query getReturnStatuses($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Return { id status }
      }
    }
  `;

  const statuses: Record<string, string> = {};
  // `nodes` is capped by Shopify's cost limits; 40 keeps us well inside it.
  for (let i = 0; i < ids.length; i += 40) {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { ids: ids.slice(i, i + 40) } }),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const { data, errors } = await response.json();
    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }
    for (const node of data?.nodes ?? []) {
      if (node?.id && node?.status) statuses[node.id] = node.status;
    }
  }
  return statuses;
}
