/**
 * Read-only historical audit: exchanges that owed EUR 0 but were charged a
 * price-difference line in Stripe anyway.
 *
 * Under the rule shipped in Tasks 1-3 of the `fix/exchange-keeps-sale-price`
 * branch, an exchange in which EVERY chosen replacement belongs to the
 * line's own product owes exactly EUR 0.00 — no catalogue arithmetic, no
 * price archaeology, regardless of what the catalogue said at the time. So
 * any such order that was nonetheless charged a Stripe "difference" line was
 * overcharged by precisely that line's amount. That is what makes this audit
 * exact rather than a reconstruction: it needs no historical prices at all.
 *
 * Candidate set: every order whose CAMBIO lines with a chosen replacement
 * (`new_variant_id`) ALL resolve, via the live Shopify catalogue, to the
 * SAME product as the line being replaced. Computed with `indexCatalogue`
 * from lib/replacementPricing.ts (Task 1).
 *
 * Stripe matching (see task-6-amendment.md — binding, and different from the
 * plan's draft, which had three real defects):
 *
 *   1. Page through checkout sessions ONCE, indexed by metadata.id — never
 *      call sessions.list() again per order, which would silently drop every
 *      order outside the newest page.
 *   2. Identify the difference line with a positive, EXACT allowlist
 *      ("New items" / "Nuevos productos"), never a substring or negative
 *      regex — "Delivery of new items" contains "new items" and would score
 *      the outbound shipping leg as a price difference.
 *   3. A session that carries the single bundled "Returns & Exchanges Fee"
 *      line (from before itemisation shipped) cannot have its difference
 *      separated from its shipping fee — report it `indeterminate`, not
 *      dropped.
 *
 * READ-ONLY. It queries Postgres, Stripe and Shopify and writes nothing to
 * any of them. It issues no refunds. Report the numbers; the refund
 * decision belongs to a human.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/audit-exchange-overcharges.ts \
 *     > .superpowers/sdd/2026-09-01-exchange-keeps-sale-price/exchange-overcharges.csv
 *
 * Output: CSV on stdout (order_id,order_number,email,status,difference_eur,
 * line_labels), a per-status summary and the euro total of `exact` rows on
 * stderr.
 *
 * `getProducts` and the rest of db/queries.ts are NOT imported here: that
 * file starts with "use server" and defines several exports wrapped in
 * React's `cache()`, which throws ("cache is not a function") the instant
 * the module loads outside a Next request context — even though this script
 * only wants the one export that isn't cache()-wrapped, importing the
 * module evaluates all of it. So the Shopify products query and the DB
 * access below are reimplemented directly against `db/drizzle` and a raw
 * fetch, exactly as the `pilar-311198` and `resend-return-label.ts`
 * precedents do.
 */
import "dotenv/config";

import { inArray } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders, productsOrder } from "@/db/schema";
import { indexCatalogue } from "@/lib/replacementPricing";
import {
  classifySessionLines,
  isAllSameProductExchange,
  type LineStatus,
} from "@/lib/exchangeOverchargeAudit";
import { stripe } from "@/lib/stripe";
import type { Product } from "@/types";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// IO — the pure decision logic lives in lib/exchangeOverchargeAudit.ts and is
// unit-tested in tests/auditExchangeOvercharges.test.ts with fixtures, no
// network. It is imported above rather than defined here so tests can import
// it without pulling in this file's `main()` call.
// ---------------------------------------------------------------------------

/**
 * The Shopify catalogue, fetched directly (not via db/queries.ts — see the
 * module comment). Trimmed to the fields `indexCatalogue` actually reads:
 * each variant's id, price, and the bare id of the product that owns it.
 *
 * Deliberately NOT `status:ACTIVE`, unlike `getProducts()`. That filter is
 * right for live pricing, which only needs sellable products — but this
 * audit asks a structural question about the past ("which product did this
 * variant belong to?"), and product-variant ownership does not change when a
 * product is later unpublished. Measured against this store: `status:ACTIVE`
 * indexes 37 products; every status indexes 83 (46 more are DRAFT, 0
 * ARCHIVED). Using ACTIVE-only undercounted same-product matches by ~21
 * lines against the plan's rough reference count — i.e. it would have
 * DROPPED real all-same-product exchanges from the candidate set (a false
 * negative that could hide a real overcharge), which is the exact failure
 * mode Task 6 exists to avoid reproducing. `first: 250` is not paginated:
 * the store has 83 products total, verified well under that page size.
 */
async function fetchCatalogueProducts(): Promise<Product[]> {
  if (!process.env.NEXT_PUBLIC_SHOP_URL || !process.env.NEXT_PUBLIC_ACCESS_TOKEN) {
    throw new Error("Missing NEXT_PUBLIC_SHOP_URL or NEXT_PUBLIC_ACCESS_TOKEN");
  }
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/graphql.json`;
  const query = `
    query getProducts {
      products(first: 250) {
        edges {
          node {
            id
            title
            handle
            status
            variants(first: 50) {
              edges { node { id price title inventoryQuantity } }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": process.env.NEXT_PUBLIC_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const { data, errors } = await res.json();
  if (errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
  if (data.products.edges.length >= 250) {
    console.error(
      "[catalogue] WARNING: hit the 250-product page limit — results may be incomplete, add cursor pagination"
    );
  }

  return data.products.edges.map(({ node }: any): Product => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    description: "",
    images: { edges: [] },
    image: { src: "" },
    variants: {
      edges: node.variants.edges.map((e: any) => ({
        node: {
          id: e.node.id,
          price: e.node.price,
          title: e.node.title,
          inventoryQuantity: e.node.inventoryQuantity ?? 0,
          grams: null,
        },
      })),
    },
  }));
}

/**
 * Page through every checkout session ONCE and index the newest paid one per
 * order id (list() returns newest first, so the first one seen per key wins
 * — this is defect 1 from the amendment).
 */
async function buildSessionIndex(): Promise<Map<string, Stripe.Checkout.Session>> {
  const byOrder = new Map<string, Stripe.Checkout.Session>();
  let scanned = 0;
  for await (const session of stripe.checkout.sessions.list({ limit: 100 })) {
    scanned++;
    const orderId = session.metadata?.id;
    if (!orderId) continue;
    if (session.payment_status !== "paid") continue;
    if (!byOrder.has(orderId)) byOrder.set(orderId, session);
  }
  console.error(`[stripe] scanned ${scanned} checkout sessions total`);
  return byOrder;
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

type ReportStatus = LineStatus | "no-session";

type ReportRow = {
  orderId: string;
  orderNumber: string;
  email: string;
  status: ReportStatus;
  differenceEur: string;
  lineLabels: string;
};

async function main() {
  // --- Step 1: candidate orders (pure DB + catalogue logic) ---------------
  const catalogue = await fetchCatalogueProducts();
  const index = indexCatalogue(catalogue);
  console.error(`[catalogue] indexed ${catalogue.length} products (any status)`);

  const rows = await db.select().from(productsOrder);
  console.error(`[db] read ${rows.length} productsorder rows`);

  const byOrder = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.orderId) continue;
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }
  console.error(`[db] ${byOrder.size} distinct orders`);

  let exchangeOrders = 0;
  let swapLineCount = 0;
  let sameProductLineCount = 0;
  const candidates: string[] = [];

  for (const [orderId, lines] of Array.from(byOrder.entries())) {
    const swaps = lines.filter((l) => l.action === "CAMBIO" && l.new_variant_id);
    if (swaps.length === 0) continue;
    exchangeOrders++;
    swapLineCount += swaps.length;
    for (const l of swaps) {
      if (index.productOf(l.new_variant_id) === String(l.productId)) {
        sameProductLineCount++;
      }
    }
    if (isAllSameProductExchange(swaps, index)) candidates.push(orderId);
  }

  console.error(
    `[candidates] ${exchangeOrders} orders contain an exchange ` +
      `(${swapLineCount} CAMBIO lines with a chosen replacement, ` +
      `${sameProductLineCount} of those lines same-product); ` +
      `${candidates.length} orders are ALL-same-product exchanges`
  );

  // --- Step 2: Stripe sessions, paginated once -----------------------------
  const sessionIndex = await buildSessionIndex();

  // --- Step 3: order metadata for the candidates ---------------------------
  const orderMeta = candidates.length
    ? await db.select().from(orders).where(inArray(orders.id, candidates))
    : [];
  const orderMetaById = new Map(orderMeta.map((o) => [o.id, o]));

  // --- Step 4: classify each candidate --------------------------------------
  const results: ReportRow[] = [];
  const counts: Record<ReportStatus, number> = {
    exact: 0,
    indeterminate: 0,
    "no-charge": 0,
    "no-session": 0,
  };
  let exactTotalCents = 0;

  for (const orderId of candidates) {
    const meta = orderMetaById.get(orderId);
    const orderNumber = meta?.orderNumber ?? "";
    const email = meta?.email ?? "";

    const session = sessionIndex.get(orderId);
    if (!session) {
      counts["no-session"]++;
      results.push({
        orderId,
        orderNumber,
        email,
        status: "no-session",
        differenceEur: "",
        lineLabels: "",
      });
      continue;
    }

    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      limit: 20,
    });
    const classification = classifySessionLines(lineItems.data);
    counts[classification.status]++;
    if (classification.status === "exact" && classification.differenceCents) {
      exactTotalCents += classification.differenceCents;
    }

    results.push({
      orderId,
      orderNumber,
      email,
      status: classification.status,
      differenceEur:
        classification.status === "exact" && classification.differenceCents
          ? (classification.differenceCents / 100).toFixed(2)
          : "",
      lineLabels: classification.labels.join("; "),
    });
  }

  // --- Output ---------------------------------------------------------------
  console.log("order_id,order_number,email,status,difference_eur,line_labels");
  for (const r of results) {
    console.log(
      [
        csvField(r.orderId),
        csvField(r.orderNumber),
        csvField(r.email),
        csvField(r.status),
        csvField(r.differenceEur),
        csvField(r.lineLabels),
      ].join(",")
    );
  }

  console.error("--- summary ---");
  for (const status of ["exact", "indeterminate", "no-charge", "no-session"] as const) {
    console.error(`${status}: ${counts[status]}`);
  }
  console.error(`exact total: EUR ${(exactTotalCents / 100).toFixed(2)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
