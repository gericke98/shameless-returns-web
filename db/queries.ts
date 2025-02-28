"use server";
import "@shopify/shopify-api/adapters/node";
import { cache } from "react";
import db from "./drizzle";
import { eq } from "drizzle-orm";
import { orders, productsOrder } from "./schema";
import { OrderData } from "@/types";
import { LineItem } from "@/types";

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

export async function createOrder(order: any, product: any) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  // Log the query to debug
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
        provinceCode: order.shippingCity,
        zip: order.shippingZip,
      },
      buyerAcceptsMarketing: true,
      currency: "EUR",
      email: order.email,
      financialStatus: "PAID",
      lineItems: [
        {
          variantId: product.new_variant_id,
          quantity: 1,
          requiresShipping: true,
        },
      ],
      note: `Exchange order for ${order.orderNumber}`,
      shippingAddress: {
        address1: order.shippingAddress1,
        address2: order.shippingAddress2 || "",
        city: order.shippingCity,
        countryCode: "ES",
        firstName: order.shippingName || "Return",
        lastName: order.lastName || "Return",
        phone: order.shippingPhone || "+34608667749",
        provinceCode: order.shippingCity,
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
            ],
            returnShippingFee: {
              amount: {
                amount: ${process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST}.00,
                currencyCode: EUR
              }
            }
          }) 
        {
          return {
            id
            returnLineItems(first: 10){
              nodes{
                id
              }
            }
            order {
              transactions(first: 1) {
                nodes {
                  id
                  amountSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
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
  try {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

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

    // Extract transaction details for refund
    const returnData = data.data.returnCreate.return;
    const transactionData = returnData.order.transactions.nodes[0];

    return {
      success: true,
      data: {
        ...returnData,
        transactionId: transactionData?.id,
        transactionAmount: transactionData?.amountSet?.shopMoney?.amount,
      },
    };
  } catch (error) {
    console.error("Fetch error:", error);
    return { success: false, error: error };
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

    if (data.errors || data.data.giftCardCreate.userErrors.length > 0) {
      console.error(
        "Error creating gift card:",
        data.errors || data.data.giftCardCreate.userErrors
      );
      return {
        success: false,
        errors: data.errors || data.data.giftCardCreate.userErrors,
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
