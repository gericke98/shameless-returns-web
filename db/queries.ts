"use server";
import "@shopify/shopify-api/adapters/node";
import { cache } from "react";
import db from "./drizzle";
import { eq } from "drizzle-orm";
import { orders, productsOrder } from "./schema";
import { OrderData, OrderLineItem } from "@/types";
import type { ReturnCreateInput } from "@/lib/returnPayload";

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

const SPANISH_PROVINCE_CODES: { [key: string]: string } = {
  Álava: "VI",
  Albacete: "AB",
  Alicante: "A",
  Almería: "AL",
  Asturias: "O",
  Ávila: "AV",
  Badajoz: "BA",
  Barcelona: "B",
  Burgos: "BU",
  Cáceres: "CC",
  Cádiz: "CA",
  Cantabria: "S",
  Castellón: "CS",
  "Ciudad Real": "CR",
  Córdoba: "CO",
  "La Coruña": "C",
  Cuenca: "CU",
  Gerona: "GI",
  Granada: "GR",
  Guadalajara: "GU",
  Guipúzcoa: "SS",
  Huelva: "H",
  Huesca: "HU",
  "Islas Baleares": "PM",
  Jaén: "J",
  León: "LE",
  Lérida: "L",
  Lugo: "LU",
  Madrid: "M",
  Málaga: "MA",
  Murcia: "MU",
  Navarra: "NA",
  Orense: "OR",
  Palencia: "P",
  "Las Palmas": "GC",
  Pontevedra: "PO",
  "La Rioja": "LO",
  Salamanca: "SA",
  "Santa Cruz de Tenerife": "TF",
  Segovia: "SG",
  Sevilla: "SE",
  Soria: "SO",
  Tarragona: "T",
  Teruel: "TE",
  Toledo: "TO",
  Valencia: "V",
  Valladolid: "VA",
  Vizcaya: "BI",
  Zamora: "ZA",
  Zaragoza: "Z",
};

function getProvinceCode(provinceName: string): string {
  // Normalize the province name by removing accents and converting to uppercase
  const normalizedName = provinceName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  // Find the matching province code
  for (const [name, code] of Object.entries(SPANISH_PROVINCE_CODES)) {
    if (
      name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase() === normalizedName
    ) {
      return code;
    }
  }

  // If no match found, return the original province name
  return provinceName;
}

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

export async function createRefund(
  returnId: string,
  returnLineItemId: string,
  transactionId: string,
  amount: number
) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  let query = `
      mutation returnRefund($input: ReturnRefundInput!) {
        returnRefund(returnRefundInput: $input) {
          refund {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

  const variables = {
    input: {
      notifyCustomer: true,
      returnId: returnId,
      orderTransactions: [
        {
          parentId: transactionId,
          transactionAmount: {
            amount: amount.toString(),
            currencyCode: "EUR",
          },
        },
      ],
      returnRefundLineItems: [
        {
          quantity: 1,
          returnLineItemId: returnLineItemId,
        },
      ],
    },
  };

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();

    if (data.errors || data.data.returnRefund.userErrors.length > 0) {
      console.error(
        "Error creating refund:",
        data.errors || data.data.returnRefund.userErrors
      );
      return {
        success: false,
        errors: data.errors || data.data.returnRefund.userErrors,
      };
    }

    return { success: true, data: data.data.returnRefund.refund };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
  }
}

/**
 * Create the replacement order for an exchange.
 *
 * Takes the LINE ITEMS, plural. It used to take a single product and was called
 * once per dashboard row, so an order with two exchanged garments produced two
 * separate Shopify orders — two parcels, two shipping charges, two things for
 * the customer to wait on.
 */
export async function createOrder(order: any, products: any[]) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  // Get province code from the province field if available, otherwise try to derive it from city
  const provinceCode = order.shippingProvince
    ? getProvinceCode(order.shippingProvince)
    : getProvinceCode(order.shippingCity);

  const query = `
    mutation OrderCreate(
      $options: OrderCreateOptionsInput, 
      $order: OrderCreateOrderInput!
    ) {
      orderCreate(options: $options, order: $order) {
        order {
          id
          name
          email
          createdAt
          shippingAddress {
            address1
            address2
            city
            countryCode
            firstName
            lastName
            phone
            provinceCode
            zip
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    options: {
      inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
      sendFulfillmentReceipt: true,
      sendReceipt: true,
    },
    order: {
      billingAddress: {
        address1: order.shippingAddress1,
        address2: order.shippingAddress2 || "",
        city: order.shippingCity,
        countryCode: "ES",
        firstName: order.shippingName || "Return",
        lastName: order.lastName || "Return",
        phone: order.shippingPhone || "+34608667749",
        provinceCode: provinceCode,
        zip: order.shippingZip,
      },
      buyerAcceptsMarketing: true,
      currency: "EUR",
      email: order.email,
      financialStatus: "PAID",
      lineItems: products.map((product) => ({
        variantId: product.new_variant_id,
        quantity: 1,
        requiresShipping: true,
      })),
      note: `Exchange order for ${order.orderNumber}`,
      shippingAddress: {
        address1: order.shippingAddress1,
        address2: order.shippingAddress2 || "",
        city: order.shippingCity,
        countryCode: "ES",
        firstName: order.shippingName || "Return",
        lastName: order.lastName || "Return",
        phone: order.shippingPhone || "+34608667749",
        provinceCode: provinceCode,
        zip: order.shippingZip,
      },
      shippingLines: [
        {
          priceSet: {
            shopMoney: {
              amount: "4.00",
              currencyCode: "EUR",
            },
          },
          title: "Estándar",
        },
      ],
      tags: ["Change", `Order ${order.orderNumber}`],
      taxesIncluded: true,
      test: false,
      transactions: [
        {
          amountSet: {
            shopMoney: {
              amount: "0.01",
              currencyCode: "EUR",
            },
          },
          kind: "SALE",
          gateway: "manual",
          status: "SUCCESS",
        },
      ],
    },
  };

  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables }),
    });

    const data = await response.json();

    // Enhanced error logging
    if (data.errors || data.data?.orderCreate?.userErrors?.length > 0) {
      console.error("Order creation failed:", {
        errors: data.errors,
        userErrors: data.data?.orderCreate?.userErrors,
        input: {
          city: order.shippingCity,
          province: order.shippingProvince,
          provinceCode,
          address: order.shippingAddress1,
        },
      });
    }

    // Defensive check: ensure the structure is as expected.
    const orderResponse = data?.data?.orderCreate;
    if (!orderResponse) {
      console.error("No orderCreate found in response:", data);
      return { success: false, error: "Missing orderCreate field" };
    }

    // Optionally, check for userErrors.
    if (orderResponse.userErrors && orderResponse.userErrors.length > 0) {
      console.error("User errors:", orderResponse.userErrors);
      return { success: false, error: orderResponse.userErrors };
    }

    // Ensure order exists.
    const createdOrder = orderResponse.order;
    if (!createdOrder) {
      console.error("Order not found in response:", data);
      return { success: false, error: "Order not found in response" };
    }
    return { success: true, data: createdOrder };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
  }
}

export async function closeReturn(returnId: string) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
      mutation {
        returnClose(id: "${returnId}") 
        {
          return {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;
  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (data.errors || data.data.returnClose.userErrors.length > 0) {
      console.error(
        "Error closing return:",
        data.errors || data.data.returnClose.userErrors
      );
      return {
        success: false,
        errors: data.errors || data.data.returnClose.userErrors,
      };
    }

    return { success: true, data: data.data.returnClose.return };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
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
    const transactionData = returnData.order.transactions[0];

    return {
      success: true as const,
      data: {
        id: returnData.id as string,
        name: returnData.name as string,
        returnLineItems: returnData.returnLineItems.nodes,
        exchangeLineItems: returnData.exchangeLineItems.nodes,
        transactionId: transactionData?.id,
        transactionAmount: transactionData?.amountSet?.shopMoney?.amount,
      },
    };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false as const, error };
  }
}

export async function processGiftCardReturn(
  customerId: string,
  price: number,
  variantId: string
) {
  const increasedPrice = price.toString();

  const giftCardResult = await createGiftCard(customerId, increasedPrice);

  if (!giftCardResult.success) {
    throw new Error("Failed to create gift card");
  }

  if (giftCardResult?.success) {
    await db
      .update(productsOrder)
      .set({
        gift_card_id: giftCardResult.data.id,
      })
      .where(eq(productsOrder.variant_id, variantId.toString()));
  }

  return giftCardResult;
}

export async function createGiftCard(customerId: string, amount: string) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  const query = `
    mutation {
      giftCardCreate(input: {
        customerId: "gid://shopify/Customer/${customerId}",
        initialValue: ${amount}
      }) {
        giftCard {
          id
        }
        userErrors {
          message
          field
          code
        }
      }
    }
  `;
  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (data.data.giftCardCreate.userErrors.length > 0) {
      console.error(
        "Error creating gift card:",
        data.data.giftCardCreate.userErrors
      );
      return {
        success: false,
        errors: data.data.giftCardCreate.userErrors,
      };
    }

    return { success: true, data: data.data.giftCardCreate.giftCard };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
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
                title
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
        variants(first: 10) {
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
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { ids: gids } }),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const { data, errors } = await response.json();
    if (errors) {
      console.error("GraphQL Errors:", errors);
      throw new Error("GraphQL query failed");
    }
    const skusById: Record<string, string> = {};
    for (const node of data?.nodes ?? []) {
      if (!node?.id || !node?.sku) continue;
      const numeric = String(node.id).replace(/^gid:\/\/shopify\/ProductVariant\//, "");
      skusById[numeric] = node.sku;
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
            variants(first: 10) {
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
