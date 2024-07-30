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
// export async function getOrderById(id: string) {
//   const session = createSession();
//   // El %23 es lo mismo que poner #
//   const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/orders.json?query=id:${id}`;

//   try {
//     const response = await fetch(url, {
//       method: "GET",
//       ...session,
//     });
//     if (!response.ok) {
//       throw new Error(`HTTP error! status: ${response.status}`);
//     }
//     const data = await response.json();
//     return data.orders[0];
//   } catch (error) {
//     console.error("Error fetching orders:", error);
//     throw error;
//   }
// }

export const getOrderById = cache(async (id: string) => {
  const data = await db.query.orders.findFirst({
    where: eq(orders.id, id),
    with: {
      products: true,
    },
  });
  return data;
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
export async function beginOrderEditing(orderId: string) {
  const session = createSession();
  const query = `
    mutation {
      orderEditBegin(id: "gid://shopify/Order/${orderId}") {
        calculatedOrder {
          id
        }
      }
    }
  `;
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/graphql.json`;
  const response = await fetch(shopifyGraphQLUrl, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  return data.data.orderEditBegin.calculatedOrder.id;
}

export async function addLineItem(
  orderVariant: string,
  variant: string,
  quantity: number
) {
  const session = createSession();

  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/graphql.json`;
  const query = `
    mutation {
      orderEditAddVariant(id: "${orderVariant}", variantId: "gid://shopify/ProductVariant/${variant}", quantity:${quantity}) {
        calculatedOrder {
          id
          addedLineItems(first: 5) {
            edges {
              node {
                id
                quantity
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const response = await fetch(shopifyGraphQLUrl, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
}
export async function removeLineItem(orderVariant: string, lineItemId: string) {
  const session = createSession();

  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/graphql.json`;
  const query = `
    mutation {
      orderEditSetQuantity(id: "${orderVariant}", lineItemId: "gid://shopify/CalculatedLineItem/${lineItemId}", quantity:0) {
        calculatedLineItem{
          id
        }
        calculatedOrder {
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

    if (data.errors) {
      console.error("GraphQL errors:", data.errors);
      return { success: false, errors: data.errors };
    }

    const userErrors = data.data.orderEditSetQuantity.userErrors;
    if (userErrors.length > 0) {
      console.error("User errors:", userErrors);
      return { success: false, errors: userErrors };
    }

    return { success: true, data: data.data.orderEditSetQuantity };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
  }
}

export async function commitChanges(orderVariant: string) {
  const session = createSession();

  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2024-04/graphql.json`;
  const query = `
    mutation {
      orderEditCommit(id: "${orderVariant}", notifyCustomer: true,staffNote: "Ha funcionado!!" ) {
        order {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  const response = await fetch(shopifyGraphQLUrl, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  return 201;
  // return data.data.orderEditAddLineItem.calculatedOrder;
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
