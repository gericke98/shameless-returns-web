"use server";
import "@shopify/shopify-api/adapters/node";
import { cache } from "react";
import db from "./drizzle";
import { eq } from "drizzle-orm";
import { orders, productsOrder } from "./schema";

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

// MUNDO SHOPIFY
export const getOrderById = cache(async (id: string) => {
  const data = await db.query.orders.findMany({
    where: eq(orders.id, id),
    with: {
      products: true,
    },
  });
  return data[0];
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

export async function createReturn(
  orderId: string,
  fulfillmentLineItem: string,
  product: any,
  discount: any
) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

  let query = `
      mutation {
        returnCreate(returnInput: 
          {
            orderId: "gid://shopify/Order/${orderId}",
            returnLineItems: [
              {
                fulfillmentLineItemId: "${fulfillmentLineItem}",
                quantity: 1,
                returnReason: COLOR
              }
            ]
          }) 
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
  // Aqui tengo que diferenciar si es una devolucion directa o un cambio
  if (product.action === "CAMBIO") {
    query = `
      mutation {
        returnCreate(returnInput: {
          exchangeLineItems: [
            {
              appliedDiscount: {
                description: "RETURN_DISCOUNT",
                value: {
                  amount: {
                    amount: ${discount.amount_set.shop_money.amount},
                    currencyCode: ${discount.amount_set.shop_money.currency_code}
                  }
                }
              },
              quantity: 1,
              variantId: "gid://shopify/ProductVariant/${product.new_variant_id}"
            }
          ],
          orderId: "gid://shopify/Order/${orderId}",
          returnLineItems: [
            {
              fulfillmentLineItemId: "${fulfillmentLineItem}",
              quantity: 1,
              returnReason: COLOR
            }
          ]
        }) {
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
  }
  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    console.log("Creating return in Shopify", data);

    if (data.errors || data.data.returnCreate.userErrors.length > 0) {
      console.error(
        "Error creating return:",
        data.errors || data.data.returnCreate.userErrors
      );
      return {
        success: false,
        errors: data.errors || data.data.returnCreate.userErrors,
      };
    }

    return { success: true, data: data.data.returnCreate.return };
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

    console.log("Fulfillment Data:", data.data.fulfillment);
    return { success: true, data: data.data.fulfillment };
  } catch (error) {
    console.error("Error:", error);
    return { success: false, error };
  }
}

export async function getProduct(id: string) {
  const session = createSession();
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/products/${id}.json`;

  try {
    const response = await fetch(url, session);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error fetching orders:", error);
    throw error;
  }
}
