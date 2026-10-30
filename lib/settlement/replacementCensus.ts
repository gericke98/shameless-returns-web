// S3 cutover coverage (Codex #3): every exchange order the pre-ledger code
// created is recorded as a replacement BY ID (legacy_replacement_orders,
// drizzle/0011) — independently of whether its funding could be reconciled —
// so the portal never values one as an ordinary order at list price.
//
// The pre-S2 `createOrder` wrote two tags and nothing else that survives:
// `Change` and `Order <number>`. The census reads every order tagged `Change`
// ONCE, completely (every page, or no census at all), and records each by its
// Shopify id. Its source order is the one order of ours whose `Order
// <order_number>` equals one of its tags exactly; none or several → NULL (it
// is still a replacement, and refuses valuation until funded). After this the
// tags are never consulted again: the rows are the identity.
//
// Shopify is only READ. NOT "use server".
import { sql } from "drizzle-orm";
import db, { transact } from "@/db/drizzle";
import { read } from "./reads";
import type { Read } from "./reconcile";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export const RECONCILE_CHANGE_ORDERS_QUERY = `
  query ReconcileChangeOrders($after: String) {
    orders(first: 250, after: $after, query: "tag:Change", sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { id tags }
    }
  }`;

export type ChangeOrder = { id: string; tags: string[] };

/** Every order tagged `Change`, every page — or no verdict. */
export async function readChangeOrders(maxPages = 400): Promise<Read<ChangeOrder[]>> {
  const out: ChangeOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const r: Read<any> = await read(RECONCILE_CHANGE_ORDERS_QUERY, { after }, (d) => d?.orders ?? null);
    if (!r.ok) return r;
    if (!r.value) return { ok: false, error: "orders connection missing" };
    for (const n of r.value.nodes ?? []) out.push({ id: String(n.id), tags: (n.tags ?? []).map(String) });
    if (!r.value.pageInfo?.hasNextPage) return { ok: true, value: out };
    after = r.value.pageInfo.endCursor ?? null;
    if (!after) return { ok: false, error: "next page without a cursor" };
  }
  return { ok: false, error: `more than ${maxPages} pages` };
}

const bareOrderId = (gid: string) => gid.replace(/^gid:\/\/shopify\/Order\//, "");

/**
 * The identity rows for a census, purely. `ours` maps each of OUR orders'
 * exact tag text `Order <order_number>` to its orders.id.
 */
export function censusRows(
  found: readonly ChangeOrder[],
  ours: ReadonlyMap<string, readonly string[]>
): Array<{ order_id: string; source_order_id: string | null }> {
  return found.map((o) => {
    const sources = new Set<string>();
    let several = false;
    for (const tag of o.tags) {
      const ids = ours.get(tag) ?? [];
      if (ids.length > 1) several = true;
      for (const id of ids) sources.add(id);
    }
    const source = !several && sources.size === 1 ? Array.from(sources)[0] : null;
    return { order_id: bareOrderId(o.id), source_order_id: source };
  });
}

/** Our orders by the exact tag the pre-S2 code wrote for them. */
export async function ourOrderTags(): Promise<Map<string, string[]>> {
  const rows = rowsOf(await db.execute(sql`SELECT id, order_number FROM orders WHERE order_number IS NOT NULL`));
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const k = `Order ${r.order_number}`;
    (map.get(k) ?? map.set(k, []).get(k)!).push(String(r.id));
  }
  return map;
}

/** One transaction: every found order's identity, then the census record. */
export async function recordCensus(
  rows: ReadonlyArray<{ order_id: string; source_order_id: string | null }>,
  runBy: string
): Promise<void> {
  await transact([
    sql`INSERT INTO legacy_replacement_orders (order_id, source_order_id, found_by)
        SELECT r.order_id, r.source_order_id, 'census'
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(order_id text, source_order_id text)
        ON CONFLICT (order_id) DO NOTHING`,
    sql`INSERT INTO legacy_replacement_census (orders_found, run_by) VALUES (${rows.length}, ${runBy})`,
  ]);
}

/** Cutover coverage: has a complete census been recorded? */
export async function censusComplete(): Promise<boolean> {
  const [r] = rowsOf(await db.execute(sql`SELECT id FROM legacy_replacement_census LIMIT 1`));
  return !!r;
}
