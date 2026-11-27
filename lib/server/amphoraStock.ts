import "server-only";
// The ONE reader of Amphora's stock (FX plan rev 2, §#2). Amphora is the
// warehouse: what it can ship is the truth; Shopify's `inventoryQuantity` is a
// mirror and a display hint only (decision 2).
//
// Source: Company API v1.15.0 `GET /inventory/{company_id}` → InventoryLevels
// (company-api-live.yaml :301-353, :5232-5286). `{company_id}` is the tenant
// the existing client puts in its paths (lib/server/amphora.ts); here it sits
// after `/inventory/`, so the URL is built here, with the same key and header.
// One call returns the whole catalogue; the spec has no pagination.
//
// What counts: exactly the rows at the warehouse that ships Shopify orders
// (`SHOPIFY_WAREHOUSE_ID`, decision 1) whose `product_type` is ITEM; the count
// is `available_quantity` ("stock available to place new orders"). Reserved,
// pending and committed never count.
//
// Identity: variant → SKU through Shopify (`getVariantSkusByIds`; Amphora SKU
// == Shopify variant SKU). Validated, not trusted: each SKU needed must be on
// EXACTLY one row at that warehouse.
//
// Unreadable is a value (`{ ok: false, reason }`), never 0 and never "enough":
//   amphora-http:<status> | amphora-transport:<message> | amphora-body
//   shopify-skus:<message> | bad-variant:<id> | no-sku:<variant gid>
//   not-at-amphora:<sku> | ambiguous:<sku> | not-item:<sku> | bad-count:<sku>
import axios from "axios";
import { getVariantSkusByIds } from "@/db/queries";
import { variantGid } from "@/lib/shopifyIds";
import type { StockRead, StockRow } from "@/lib/stockCoverage";
import { amphoraEnv } from "./serviceEnv";

/**
 * Decision 1 (Santi, 2026-11-26): the one Amphora warehouse that ships
 * Shopify orders. Live read that day: all 353 rows of `GET /inventory/
 * Shameless` are at location "10". Explicit config, never inferred.
 */
export const SHOPIFY_WAREHOUSE_ID = "10";

const numericOf = (gid: string) => gid.replace(/^gid:\/\/shopify\/ProductVariant\//, "");

async function inventoryAtWarehouse(): Promise<{ ok: true; rows: any[] } | { ok: false; reason: string }> {
  const cfg = amphoraEnv();
  try {
    const res = await axios.get(`${cfg.base}/inventory/${encodeURIComponent(cfg.tenant)}`, {
      params: { warehouses: SHOPIFY_WAREHOUSE_ID, shop_name: cfg.shopName },
      headers: { "x-api-key": cfg.apiKey, Accept: "application/json" },
    });
    const levels = res.data?.inventory_levels;
    if (!Array.isArray(levels)) return { ok: false, reason: "amphora-body" };
    return { ok: true, rows: levels.filter((row) => String(row?.location_id) === SHOPIFY_WAREHOUSE_ID) };
  } catch (error: any) {
    if (error?.response?.status) return { ok: false, reason: `amphora-http:${error.response.status}` };
    return { ok: false, reason: `amphora-transport:${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/**
 * Stock for the variants `need` asks about, and the SKU of every variant in
 * `need` and `demand`. `demand` is other customers' open exchange lines:
 * their SKUs must be known (an unmapped one is unattributable demand, so the
 * read fails closed), but only the SKUs `need` asks for are checked at Amphora
 * — demand on any other SKU cannot change this answer.
 */
export async function readAvailable(
  need: readonly string[],
  demand: readonly string[] = []
): Promise<StockRead> {
  const gids: string[] = [];
  for (const id of [...need, ...demand]) {
    const gid = variantGid(id);
    if (!gid) return { ok: false, reason: `bad-variant:${id}` };
    gids.push(gid);
  }
  const unique = Array.from(new Set(gids));

  let skus: Record<string, string>;
  try {
    skus = unique.length ? await getVariantSkusByIds(unique) : {};
  } catch (error: any) {
    return { ok: false, reason: `shopify-skus:${String(error?.message ?? error).slice(0, 200)}` };
  }
  const skuOf = new Map<string, string>();
  for (const gid of unique) {
    const sku = skus[numericOf(gid)];
    if (!sku) return { ok: false, reason: `no-sku:${gid}` };
    skuOf.set(gid, sku);
  }

  const needed = Array.from(new Set(need.map((id) => skuOf.get(variantGid(id)!)!)));
  if (needed.length === 0) return { ok: true, bySku: new Map(), skuOf };

  const inventory = await inventoryAtWarehouse();
  if (!inventory.ok) return inventory;

  const bySku = new Map<string, StockRow>();
  for (const sku of needed) {
    const rows = inventory.rows.filter((row) => row?.sku === sku);
    if (rows.length === 0) return { ok: false, reason: `not-at-amphora:${sku}` };
    if (rows.length > 1) return { ok: false, reason: `ambiguous:${sku}` };
    const [row] = rows;
    if (row.product_type !== "ITEM") return { ok: false, reason: `not-item:${sku}` };
    const available = row.available_quantity;
    if (!Number.isInteger(available) || available < 0) return { ok: false, reason: `bad-count:${sku}` };
    bySku.set(sku, { productId: String(row.product_id), locationId: String(row.location_id), available });
  }
  return { ok: true, bySku, skuOf };
}
