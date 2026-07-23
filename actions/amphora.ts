import axios from "axios";

/**
 * Amphora Logistics Company API client (international returns/exchanges).
 *
 * Auth: `x-api-key` header; the tenant id is a path segment
 * (`{base}/{tenant}/...`). The key is Company-API-scoped only — the
 * E-Commerce API host returns 403 for it.
 *
 * Amphora arranges the carrier + garment COLLECTION, so there is no label to
 * render: a created return exposes `carrier` / `carrier_number` / `carrier_url`
 * (a tracking URL) which we surface in the customer confirmation email.
 *
 * Server-only: reads secret env vars. Do not import from a client component.
 */

const DEFAULT_BASE = "https://api.amphoralogistics.com/prod-integrations-api";
const DEFAULT_SHOP_NAME = "shameless-collective-madrid.myshopify.com";

type AmphoraConfig = {
  base: string;
  tenant: string;
  apiKey: string;
  shopName: string;
};

function getConfig(): AmphoraConfig {
  const apiKey = process.env.AMPHORA_API_KEY;
  const tenant = process.env.AMPHORA_TENANT_ID;
  if (!apiKey || !tenant) {
    throw new Error("Amphora is not configured (AMPHORA_API_KEY / AMPHORA_TENANT_ID missing)");
  }
  return {
    apiKey,
    tenant,
    base: process.env.AMPHORA_COMPANY_API_URL || DEFAULT_BASE,
    shopName: process.env.AMPHORA_SHOP_NAME || DEFAULT_SHOP_NAME,
  };
}

async function amphoraRequest<T = any>(
  method: "GET" | "POST",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const cfg = getConfig();
  const url = `${cfg.base}/${encodeURIComponent(cfg.tenant)}${path}`;
  const res = await axios.request<T>({
    method,
    url,
    params: opts.query,
    data: opts.body,
    headers: {
      "x-api-key": cfg.apiKey,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    // Let callers decide on non-2xx via thrown error (axios throws by default).
  });
  return res.data;
}

// ── Types (subset of the fields we use) ──────────────────────────────────────

export type AmphoraLineItem = { sku: string; quantity: number };

export type AmphoraReturn = {
  id: string;
  external_id: string | null;
  internal_status: string;
  name: string | null;
  warehouse_id?: string;
  exchange_order_id?: string | null;
  carrier?: string | null;
  carrier_number?: string | null;
  carrier_url?: string | null;
  items?: Array<{ sku: string | null; quantity: number; product_id?: string }>;
  exchange_items?: Array<{ sku: string | null; quantity: number; product_id?: string }>;
  shipping_address_country_code?: string | null;
};

export type CreateReturnInput = {
  /** Amphora-internal order id (resolve via resolveAmphoraOrderId). */
  orderId: string;
  items: AmphoraLineItem[];
  /** Our own reference for idempotency/reconciliation (e.g. our return id). */
  externalId: string;
  /** ISO-8601 timestamp. */
  time: string;
  name?: string;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress?: string;
  shippingAddress2?: string;
  shippingCity?: string;
  shippingCountryCode?: string;
  shippingZip?: string;
  shippingName?: string;
  /** Move straight to APPROVED so the collection is arranged immediately. */
  autoApprove?: boolean;
};

export type CreateOrderInput = {
  /** Order id we assign (must be unique in Amphora). */
  id: string;
  name?: string;
  time: string;
  price: number;
  currency: string;
  items: Array<{ sku: string; quantity: number; price: string }>;
  customerEmail?: string;
  customerPhone?: string;
  shippingAddress: string;
  shippingAddress2?: string;
  shippingCity: string;
  shippingCountryCode: string;
  shippingZip: string;
  shippingName: string;
  /** Free-form; candidate mechanism for linking an exchange to its return. */
  metadata?: Record<string, unknown>;
};

// ── Order id ─────────────────────────────────────────────────────────────────

/**
 * Amphora's internal order id for a standard order is `"SHP " + the Shopify
 * legacyResourceId` (verified against live data: #39613 → "SHP 12952047911238",
 * #310443 → "SHP 13125264638278"). Our `orders.id` IS that Shopify id, so we can
 * derive the Amphora order id with no network call and no dependence on
 * Amphora's `/orders` retention window. Prefer this over `resolveAmphoraOrderId`.
 */
export function amphoraOrderIdFromShopifyId(shopifyOrderId: string): string {
  return `SHP ${shopifyOrderId}`;
}

// ── Reads (safe to run against production) ───────────────────────────────────

/**
 * Map a Shopify order name (e.g. "#310228") to Amphora's internal order id via
 * `/orders`. Fallback for when only the name is known — note `/orders` has a
 * retention window, so orders long past their return window may not be found
 * (use `amphoraOrderIdFromShopifyId` when you have the Shopify order id).
 * Returns null if Amphora has no matching order.
 */
export async function resolveAmphoraOrderId(orderName: string): Promise<string | null> {
  // `order_names` is a selective server-side filter, but /orders applies a
  // narrow default time window when `created_after` is omitted — so an older
  // order (whose return arrives weeks later) wouldn't be found. Widen the
  // window generously; the name filter still returns only the match(es).
  const createdAfter = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
  const data = await amphoraRequest<{ orders?: Array<{ id: string; name?: string }> }>(
    "GET",
    "/orders",
    { query: { order_names: orderName, created_after: createdAfter } },
  );
  const orders = data.orders ?? [];
  // Prefer an exact name match; fall back to the first result.
  const match = orders.find((o) => o.name === orderName) ?? orders[0];
  return match?.id ?? null;
}

/**
 * Fetch the Amphora return(s) for an order name — used after creation to read
 * back the assigned carrier + tracking for the confirmation email.
 */
export async function getAmphoraReturnsByOrderName(orderName: string): Promise<AmphoraReturn[]> {
  const data = await amphoraRequest<{ return_orders?: AmphoraReturn[]; returns?: AmphoraReturn[] }>(
    "GET",
    "/returns",
    { query: { order_names: orderName } },
  );
  return data.return_orders ?? data.returns ?? [];
}

// ── Writes (create real returns/collections — never call during discovery) ───

/** Create a return (Amphora arranges carrier + garment collection). */
export async function createAmphoraReturn(input: CreateReturnInput): Promise<AmphoraReturn> {
  const cfg = getConfig();
  const return_order = {
    order_id: input.orderId,
    items: input.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    shop_name: cfg.shopName,
    external_id: input.externalId,
    time: input.time,
    ...(input.name ? { name: input.name } : {}),
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.customerPhone ? { customer_phone: input.customerPhone } : {}),
    ...(input.shippingAddress ? { shipping_address: input.shippingAddress } : {}),
    ...(input.shippingAddress2 ? { shipping_address2: input.shippingAddress2 } : {}),
    ...(input.shippingCity ? { shipping_address_city: input.shippingCity } : {}),
    ...(input.shippingCountryCode ? { shipping_address_country_code: input.shippingCountryCode } : {}),
    ...(input.shippingZip ? { shipping_address_zip: input.shippingZip } : {}),
    ...(input.shippingName ? { shipping_address_name: input.shippingName } : {}),
    // NOTE: `auto_approve` is intentionally NOT sent — Amphora's API rejects it
    // with 422 "Invalid properties: {'auto_approve'}" (verified live 2026-07-23).
    // Returns are created without it; confirm on the first live test whether the
    // collection is arranged automatically or needs a separate approve step.
  };
  const data = await amphoraRequest<{ return_order: AmphoraReturn }>("POST", "/returns", {
    body: { return_order },
  });
  return data.return_order;
}

/** Create an outbound order (the replacement leg of an exchange). */
export async function createAmphoraOrder(input: CreateOrderInput): Promise<unknown> {
  const order = {
    id: input.id,
    time: input.time,
    price: input.price,
    currency: input.currency,
    items: input.items.map((i) => ({ sku: i.sku, quantity: i.quantity, price: i.price })),
    shipping_address: input.shippingAddress,
    shipping_address_city: input.shippingCity,
    shipping_address_country_code: input.shippingCountryCode,
    shipping_address_zip: input.shippingZip,
    shipping_address_name: input.shippingName,
    ...(input.name ? { name: input.name } : {}),
    ...(input.shippingAddress2 ? { shipping_address2: input.shippingAddress2 } : {}),
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(input.customerPhone ? { customer_phone: input.customerPhone } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  return amphoraRequest("POST", "/orders", { body: { order } });
}
