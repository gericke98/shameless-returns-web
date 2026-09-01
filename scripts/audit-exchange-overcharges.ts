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
 * R19 (fix round 1): a bundled line is not always a dead end. For an
 * all-same-product exchange the correct charge is the SHIPPING FEE ALONE
 * (the difference is zero by construction), and that fee is reconstructible
 * from the seeded `shipping_fees` table by destination zone and parcel
 * weight — PROVIDED the order was priced under the same rules that table
 * encodes today. Historical parcel weight is deterministic (every parcel in
 * this window was weighed at the pre-fix 500g/item fallback — see
 * lib/basket.ts's `FALLBACK_ITEM_GRAMS` and commit bc374a7). Where the fee
 * MODEL itself differed (before commit 7919d72 merged, an exchange fee was a
 * completely different, known-wrong formula) or a specific zone's rate did
 * not (Israel and the derived `*` fallback moved a day later, commit
 * 38aeb59), reconstruction is unsound and the order stays `indeterminate` —
 * see lib/exchangeOverchargeAudit.ts's cutover constants for the exact
 * verification. `reconstructed` / `reconstructed-clean` /
 * `reconstructed-undercharged` are NEVER merged into `exact`: `exact` means
 * Stripe's own itemisation said so directly, with no reconstruction at all.
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
 * line_labels), a per-status summary and the euro total of `exact` and of
 * `reconstructed` rows on stderr.
 *
 * `getProducts` and the rest of db/queries.ts are NOT imported here: that
 * file starts with "use server" and defines several exports wrapped in
 * React's `cache()`, which throws ("cache is not a function") the instant
 * the module loads outside a Next request context — even though this script
 * only wants the one export that isn't cache()-wrapped, importing the
 * module evaluates all of it. So the Shopify products query and the DB
 * access below are reimplemented directly against `db/drizzle` and a raw
 * fetch, exactly as the `pilar-311198` and `resend-return-label.ts`
 * precedents do. `db/fees.ts`'s `getFeeTable` has the same problem from a
 * different direction — it wraps its reader in Next's `unstable_cache`,
 * which is also request-context-bound — so the fee table below is read with
 * a plain `db.select()` mirroring its grouping/sorting exactly, not by
 * importing it.
 */
import "dotenv/config";

import { inArray } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders, productsOrder, shippingFees } from "@/db/schema";
import { FALLBACK_ITEM_GRAMS } from "@/lib/basket";
import { feesForCountry, resolveFee, type FeeBand, type FeeTable } from "@/lib/fees";
import { indexCatalogue } from "@/lib/replacementPricing";
import { resolveZone } from "@/lib/zones";
import {
  classifyResidual,
  classifySessionLines,
  EXCHANGE_FEE_MODEL_CUTOVER_UNIX,
  isAllSameProductExchange,
  isReconstructionSound,
  reconstructBasketFromLines,
  type LineStatus,
  type ReconstructedStatus,
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

/**
 * The current `shipping_fees` table, read directly (not via `db/fees.ts`'s
 * `getFeeTable` — see the module comment) and grouped/sorted exactly as it
 * does: ascending by `maxGrams` per country, since `feesForWeight` depends
 * on that order as a precondition.
 */
async function fetchFeeTable(): Promise<FeeTable> {
  const rows = await db.select().from(shippingFees);
  const table: Record<string, FeeBand[]> = {};
  for (const row of rows) {
    (table[row.countryCode] ??= []).push({
      maxGrams: row.maxGrams,
      returnFeeCents: row.returnFeeCents,
      exchangeFeeCents: row.exchangeFeeCents,
    });
  }
  for (const bands of Object.values(table)) {
    bands.sort((a, b) => a.maxGrams - b.maxGrams);
  }
  console.error(
    `[fees] read ${rows.length} shipping_fees rows across ${Object.keys(table).length} zones`
  );
  return table;
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

type ReportStatus = LineStatus | "no-session" | ReconstructedStatus;

const REPORT_STATUSES: readonly ReportStatus[] = [
  "exact",
  "reconstructed",
  "reconstructed-clean",
  "reconstructed-undercharged",
  "indeterminate",
  "no-charge",
  "no-session",
];

type ReportRow = {
  orderId: string;
  orderNumber: string;
  email: string;
  status: ReportStatus;
  differenceEur: string;
  lineLabels: string;
};

const BUNDLED_FEE_LABEL_TRIMMED = "Returns & Exchanges Fee";

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

  // --- Step 3: order metadata + fee table for the candidates ---------------
  const orderMeta = candidates.length
    ? await db.select().from(orders).where(inArray(orders.id, candidates))
    : [];
  const orderMetaById = new Map(orderMeta.map((o) => [o.id, o]));
  const feeTable = await fetchFeeTable();

  // --- Step 4: classify each candidate --------------------------------------
  const results: ReportRow[] = [];
  const counts: Record<ReportStatus, number> = {
    exact: 0,
    reconstructed: 0,
    "reconstructed-clean": 0,
    "reconstructed-undercharged": 0,
    indeterminate: 0,
    "no-charge": 0,
    "no-session": 0,
  };
  // R19 sanity-check counters — reported alongside the CSV so a reader can
  // see WHY each unsound order was left indeterminate, not just that it was.
  let preCutoverCount = 0;
  let israelGapCount = 0;
  let otherUnsoundCount = 0;
  let exactTotalCents = 0;
  let reconstructedTotalCents = 0;

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

    if (classification.status !== "indeterminate") {
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
      continue;
    }

    // --- R19: attempt to reconstruct the bundled fee -----------------------
    const bundledLine = lineItems.data.find(
      (li) => (li.description ?? "").trim() === BUNDLED_FEE_LABEL_TRIMMED
    );
    const bundledCents = bundledLine?.amount_total ?? null;
    const lines = byOrder.get(orderId) ?? [];
    const basket = reconstructBasketFromLines(
      lines.map((l) => ({ action: l.action, price: l.price, quantity: l.quantity })),
      FALLBACK_ITEM_GRAMS
    );
    const zone = resolveZone(meta?.shippingCountry ?? null, meta?.shippingZip ?? null);
    const usedFallbackZone = !(zone && feeTable[zone]?.length);

    let status: ReportStatus = "indeterminate";
    let differenceEur = "";
    let reason = "";

    if (bundledCents == null) {
      otherUnsoundCount++;
      reason = "no bundled fee amount found on the session";
    } else if (!basket.hasItems) {
      otherUnsoundCount++;
      reason = "no active productsorder lines to reconstruct a basket from";
    } else if (meta?.returnMethod === "SELF") {
      // Defensive only: the self-booked lane (2026-08-24) postdates every
      // bundled-fee session by a month, so this should never actually fire.
      otherUnsoundCount++;
      reason = "self-booked return — unexpected for a pre-itemisation session";
    } else if (
      !isReconstructionSound({
        sessionCreatedUnix: session.created,
        zone,
        usedFallbackZone,
      })
    ) {
      if (session.created < EXCHANGE_FEE_MODEL_CUTOVER_UNIX) {
        preCutoverCount++;
        reason =
          "before the exchange-fee-model cutover (commit 7919d72 / PR #15) — different rule, not reconstructable";
      } else {
        israelGapCount++;
        reason =
          `zone ${zone ?? "*"} priced between the exchange-fee-model cutover and the ` +
          `Israel repricing (commit 38aeb59 / PR #23) — current rate does not apply yet`;
      }
    } else {
      const bands = feesForCountry(feeTable, zone);
      const fee = resolveFee(bands, basket);
      const residual = classifyResidual(bundledCents, fee.feeCents);
      status = residual.status;
      counts[status]++;
      if (status === "reconstructed") reconstructedTotalCents += residual.residualCents;
      differenceEur = (residual.residualCents / 100).toFixed(2);
      reason =
        `reconstructed: expected €${(fee.feeCents / 100).toFixed(2)} ` +
        `(zone ${zone ?? "*"}, ${fee.kind}, ${basket.grams}g) vs charged ` +
        `€${(bundledCents / 100).toFixed(2)}`;
    }

    if (status === "indeterminate") counts.indeterminate++;

    results.push({
      orderId,
      orderNumber,
      email,
      status,
      differenceEur,
      lineLabels: [...classification.labels, reason].join("; "),
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
  for (const status of REPORT_STATUSES) {
    console.error(`${status}: ${counts[status]}`);
  }
  console.error(
    `  of which indeterminate: ${preCutoverCount} before the fee-model cutover, ` +
      `${israelGapCount} in the Israel-repricing gap, ${otherUnsoundCount} other ` +
      `(no bundled amount / no active lines / self-booked)`
  );
  console.error(`exact total: EUR ${(exactTotalCents / 100).toFixed(2)}`);
  console.error(`reconstructed (overcharge) total: EUR ${(reconstructedTotalCents / 100).toFixed(2)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
