"use server";
import "@shopify/shopify-api/adapters/node";
import { cache } from "react";
import db from "./drizzle";
import { and, desc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { orders, productsOrder, returnLabels } from "./schema";
import { OrderData, OrderLineItem } from "@/types";
import type { ReturnCreateInput } from "@/lib/returnPayload";
import { normalizeCountry } from "@/lib/countries";
import { alertOps } from "@/actions/opsAlert";

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
 * Record a store-credit return as refunded on Shopify, moving no money.
 *
 * The credit lane pays the customer with `giftCardCreate` and used to stop
 * there, which left Shopify believing nothing had come back: the order kept
 * reading `PAID` with `totalRefunded 0.00` and an empty `refunds` list forever,
 * so every returned garment still counted as revenue. #311449 (Borja Bueno) is
 * the row that showed it — gift card EUR 37.41 issued, refund record absent.
 *
 * `orderTransactions` is deliberately OMITTED rather than sent as zero. It is
 * optional on `ReturnRefundInput`, and it is the field that decides whether
 * money leaves the gateway. The customer has already been paid, in credit;
 * naming a transaction here would refund them to their card as well and pay
 * them twice for one garment. What is left is the accounting half — the goods
 * come back, the revenue is reversed, the gift card stands as the liability.
 */
export async function createStoreCreditRefund(
  returnId: string,
  returnLineItemId: string
) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const query = `
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
      // The customer already has their money as credit, and the gift card
      // email told them so. A second notification here announces a refund to
      // a card that is never coming.
      notifyCustomer: false,
      returnId,
      returnRefundLineItems: [
        {
          quantity: 1,
          returnLineItemId,
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
        "Error recording store-credit refund:",
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
 * Say on the order itself that the customer was paid in store credit.
 *
 * `createStoreCreditRefund` books the goods back, but it cannot make the order
 * stop reading `PAID` at `0.00` refunded — those two fields sum refund
 * TRANSACTIONS, and a store-credit return moves no money by design. Anyone
 * opening the order in the admin therefore sees a fully paid order with a
 * return against it and no explanation. This is the explanation.
 *
 * Appends, never replaces. `orderUpdate` takes `note` as a whole string, and
 * the customer's own checkout note lands in that same field — overwriting it
 * would destroy something only the customer could have written. (`tags` on
 * `OrderInput` replace wholesale for the same reason; Amphora owns the tags on
 * these orders, so anything tag-shaped has to go through `tagsAdd` instead.)
 *
 * Idempotent on the gift card id, so re-running settlement cannot stack the
 * same sentence twice.
 */
export async function noteStoreCreditOnOrder(
  orderId: string,
  giftCardValue: number,
  giftCardId: string
) {
  const session = createSession();
  const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;
  const gid = `gid://shopify/Order/${orderId}`;

  const post = async (query: string, variables: Record<string, unknown>) => {
    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables }),
    });
    return response.json();
  };

  try {
    const read = await post(
      `query orderNote($id: ID!) { order(id: $id) { note } }`,
      { id: gid }
    );
    if (read.errors) {
      console.error("Error reading order note:", read.errors);
      return { success: false, errors: read.errors };
    }

    const existing: string = read.data?.order?.note ?? "";
    if (existing.includes(giftCardId)) {
      return { success: true, alreadyNoted: true };
    }

    const line = `Return paid in store credit: gift card ${giftCardValue.toFixed(
      2
    )} EUR (${giftCardId}). No money was refunded to the customer's card, so this order stays PAID.`;
    const note = existing ? `${existing}\n${line}` : line;

    const written = await post(
      `mutation orderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
      { input: { id: gid, note } }
    );

    if (written.errors || written.data.orderUpdate.userErrors.length > 0) {
      console.error(
        "Error writing order note:",
        written.errors || written.data.orderUpdate.userErrors
      );
      return {
        success: false,
        errors: written.errors || written.data.orderUpdate.userErrors,
      };
    }

    return { success: true, data: written.data.orderUpdate.order };
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

  // The customer's OWN country, not the shop's.
  //
  // This was hardcoded to "ES" in both addresses below. We store the country as
  // a display NAME ("Belgium", "Portugal") and Shopify wants an ISO-2 code, so
  // whoever wrote it had a name, needed a code, and typed the shop's own.
  // Measured 2026-08-26: 4 of 195 exchange orders shipped under the wrong
  // country — #311370, #311687, #311688, #311689 — three of them in one day.
  //
  // The zips were never wrong. A four-digit Belgian zip filed under Spain just
  // READS as a broken Spanish postcode, which is why this looked like a zip bug.
  const countryCode = normalizeCountry(order.shippingCountry);
  if (!countryCode) {
    // Refuse rather than guess. Defaulting to the shop's own country is exactly
    // what shipped those four parcels to Spain, and a parcel sent to the wrong
    // nation is worse than an exchange that visibly did not happen: returning
    // failure leaves the line unsettled and still visible in the dashboard.
    console.error(
      `createOrder: cannot resolve country ${JSON.stringify(order.shippingCountry)} for order ${order.orderNumber} — refusing to create the exchange`
    );
    await alertOps(
      `[returns] EXCHANGE NOT CREATED — unresolvable country on ${order.orderNumber}`,
      [
        `The exchange order for ${order.orderNumber} was not created because we could not resolve its country to an ISO-2 code.`,
        `Stored country: ${JSON.stringify(order.shippingCountry)}`,
        `Nothing was charged and no parcel was booked. The return line is still unsettled in the dashboard.`,
        `Fix by correcting the country on the order, or by adding it to lib/countries.ts, then settling the return again.`,
      ].join("\n")
    );
    return { success: false, error: "Unresolvable shipping country" };
  }

  // Province codes are Spanish-only: SPANISH_PROVINCE_CODES is the whole table,
  // and getProvinceCode returns its INPUT UNCHANGED when nothing matches. With
  // the province field blank the city was passed in instead, so order #311687
  // sent "Woluwe-Saint-Pierre" — a Belgian city — as a province code. Omit the
  // field abroad rather than send a value we cannot map.
  const provinceCode =
    countryCode === "ES"
      ? order.shippingProvince
        ? getProvinceCode(order.shippingProvince)
        : getProvinceCode(order.shippingCity)
      : undefined;

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
        countryCode,
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
        countryCode,
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

/**
 * Mint the store-credit gift card and record it against the line that earned it.
 *
 * Takes the ORDER too, and not because it is convenient: the stamp used to be
 * scoped by `variant_id` alone, which is not an identity. Every customer who
 * ever returned the same garment shares that value, so minting one card wrote
 * its id onto all of their rows — a different customer's settled money refund
 * would start reporting a gift card it never received. Settling #311449 (Borja
 * Bueno, 2026-08-24) overwrote #310927 (Marcos G. Merino) exactly that way, and
 * 30 of the 150 stamped rows in production were already sharing an id.
 */
export async function processGiftCardReturn(
  customerId: string,
  price: number,
  variantId: string,
  orderId: string
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
      .where(
        and(
          eq(productsOrder.orderId, orderId.toString()),
          eq(productsOrder.variant_id, variantId.toString())
        )
      );
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

/**
 * Cancel a Shopify return.
 *
 * `returnCancel(id: ID!)` takes the id and nothing else — confirmed by schema
 * introspection against 2025-01.
 *
 * Reports failure rather than throwing. Its only caller has already cancelled
 * the Amphora return and cannot undo that, so it must be able to carry on and
 * alert a human instead of dying mid-chain.
 */
export async function cancelShopifyReturn(
  returnId: string
): Promise<{ success: boolean; errors?: unknown }> {
  try {
    // Inside the try deliberately: createSession() throws synchronously when
    // the Shopify env vars are missing, and by the time this runs the caller
    // has already cancelled the Amphora return and cannot undo that. An
    // escaping throw here would strand the customer with no return and no
    // refund instead of a reportable failure.
    const session = createSession();
    const shopifyGraphQLUrl = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/2025-01/graphql.json`;

    const query = `
    mutation CancelReturn($id: ID!) {
      returnCancel(id: $id) {
        return { id status }
        userErrors { field message }
      }
    }
  `;

    const response = await fetch(shopifyGraphQLUrl, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ query, variables: { id: returnId } }),
    });
    const data = await response.json();
    const userErrors = data?.data?.returnCancel?.userErrors ?? [];

    if (data.errors || userErrors.length > 0) {
      console.error("Error cancelling return:", data.errors || userErrors);
      return { success: false, errors: data.errors || userErrors };
    }
    return { success: true };
  } catch (error) {
    console.error("Fetch error cancelling return:", error);
    return { success: false, errors: error };
  }
}

/**
 * Put an order back to the state it was in before the customer submitted.
 *
 * NOT `updateFinalOrder(revert)`. That path refuses to reset any row carrying a
 * `return_id` — a guard added after #310957, where a catch-all revert wiped a
 * live Shopify return and left the customer with nothing. The guard is correct
 * and stays. This function is the deliberate counterpart: it runs only after
 * eligibility has been verified and the Shopify return has actually been
 * cancelled, so clearing the id records reality rather than hiding it.
 *
 * `stripePaymentIntent` is cleared along with the tracking: it belongs to the
 * charge for the return that no longer exists, and has just been refunded.
 * Leaving it behind attaches a dead intent to whatever the customer does next
 * — a free second return would be handed `pi_1` and either replay the first
 * refund or fail into a manual-refund alert for a return that cost nothing,
 * and a PAID second return whose webhook intent-write was swallowed would be
 * short-circuited past `resolvePaymentIntentId`'s session lookup and never
 * refunded at all. `refunded` on the LINES is not cleared, deliberately: that
 * is the permanent record that we settled that garment.
 */
export async function resetOrderReturn(orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({
      locator: null,
      carrier: null,
      carrierUrl: null,
      returnStatus: null,
      stripePaymentIntent: null,
      // The self-booked lane's four columns belong to the return being undone
      // just as much as the tracking above, and cancel-before-posting is the
      // PRIMARY self-booked cancel path — so leaving them set is not a corner
      // case. Two things go wrong if they survive:
      //
      //  (a) `getSelfReturnsAwaitingTracking` still matches the row on every
      //      clause, and the nudge sweep reads no line-item state. At day 3 the
      //      customer is asked "Have you sent your return yet?" for a return we
      //      cancelled and refunded; at day 10 ops gets an alert asserting the
      //      Shopify return is live and the Amphora ticket still PENDING, both
      //      false. That is the class of misleading alert that nearly caused a
      //      wrong refund on #311329.
      //  (b) `createSelfBookedReturn` reads a non-null `returnSubmittedAt` as a
      //      duplicate submit and returns 200 — so a SECOND self-booked return
      //      is silently swallowed: `returnFunction` does not revert and does
      //      not alert, and the customer lands on /success with a live Shopify
      //      return, no Amphora ticket, no instructions email and no tracking
      //      link.
      returnMethod: null,
      returnSubmittedAt: null,
      trackingSubmittedAt: null,
      trackingNudgeStage: 0,
    })
    .where(eq(orders.id, orderId));

  await db
    .update(productsOrder)
    .set({
      confirmed: false,
      return_id: null,
      return_line_item_id: null,
      action: null,
      reason: null,
      notes: null,
      new_variant_id: null,
      new_variant_title: null,
      // `changed` belongs to the selection being cleared, not to the history
      // being kept. It is what the portal RENDERS from: productLineClient
      // strikes the size through on `changed`, and shows the replacement
      // beside it only when `new_variant_title` survives too. Clearing one
      // without the other left #311258's line struck through with nothing
      // next to it — an exchange for nothing, on a return already cancelled
      // and refunded. `refunded` on the lines is still deliberately kept
      // (see above); this is not that.
      changed: false,
    })
    .where(eq(productsOrder.orderId, orderId));
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
