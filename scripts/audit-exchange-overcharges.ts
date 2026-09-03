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
 * R20 (fix round 2) — THE AUDIT'S POWER, stated plainly because a reader can
 * otherwise mistake "zero provable overcharges" for "no customer was
 * overcharged", which this data does NOT establish. Pre-branch,
 * `applyGlobalDiscount` derived one discount ratio from the order's FIRST
 * line and applied it to every line; on a SINGLE-line same-product
 * exchange that ratio reproduces the paid price exactly, so the difference
 * is EUR 0.00 by construction regardless of the bug. The bug could only
 * ever mis-price a MULTI-line order. Of 201 all-same-product candidates,
 * only the `exact`+`no-charge` rows are decidable at all (Stripe told us
 * the real number); everything else — pre-cutover bundled, or no paid
 * session — is invisible to every method available here. Of the decidable
 * set, only orders with more than one `productsorder` row are the
 * configuration the bug could have touched at all. See the stderr "POWER"
 * block at the end of a run for the exact counts, computed fresh each run,
 * not hardcoded.
 *
 * R20 also: (a) includes the 4 orders excluded by the all-same-product
 * filter that still hold at least one same-product swap line (a "mixed"
 * order — see `findMixedCandidates` below), reported as their own labelled
 * category rather than silently folded into the 201; (b) reports, each run,
 * how many paid Stripe sessions carry no `metadata.id` at all and therefore
 * cannot be matched to any order — some of these are the site owner's own
 * test payments, but not provably all of them, so the `no-session` count is
 * reported as a lower bound on "nothing charged", not a certainty.
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

import { inArray, type InferSelectModel } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders, productsOrder, shippingFees } from "@/db/schema";
import { FALLBACK_ITEM_GRAMS } from "@/lib/basket";
import { feesForCountry, resolveFee, sameZone, type FeeBand, type FeeTable } from "@/lib/fees";
import { indexCatalogue } from "@/lib/replacementPricing";
import { resolveZone } from "@/lib/zones";
import {
  classifyResidual,
  classifySessionLines,
  EXCHANGE_FEE_MODEL_CUTOVER_UNIX,
  isAllSameProductExchange,
  isMixedSameProductExchange,
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

type SessionIndexResult = {
  byOrder: Map<string, Stripe.Checkout.Session>;
  scanned: number;
  /** Paid sessions with no `metadata.id` at all — cannot be matched to any
   *  order, so `no-session` is a lower bound on "nothing charged", not a
   *  certainty (R20). Split so a reader can see how many are plausibly the
   *  site owner's own smoke-test payments vs a real customer. */
  unmatchedPaid: { email: string | null; amountCents: number | null; createdUnix: number }[];
  unmatchedUnpaid: number;
  /** Orders with more than one PAID session — the index keeps only the
   *  newest (defect 1 fix); worth surfacing so that choice is visible. */
  multiSessionOrders: string[];
};

/**
 * Page through every checkout session ONCE and index the newest paid one per
 * order id (list() returns newest first, so the first one seen per key wins
 * — this is defect 1 from the amendment).
 */
async function buildSessionIndex(): Promise<SessionIndexResult> {
  const byOrder = new Map<string, Stripe.Checkout.Session>();
  const sessionCountByOrder = new Map<string, number>();
  const unmatchedPaid: SessionIndexResult["unmatchedPaid"] = [];
  let unmatchedUnpaid = 0;
  let scanned = 0;
  for await (const session of stripe.checkout.sessions.list({ limit: 100 })) {
    scanned++;
    const orderId = session.metadata?.id;
    if (!orderId) {
      if (session.payment_status === "paid") {
        unmatchedPaid.push({
          email: session.customer_details?.email ?? session.customer_email ?? null,
          amountCents: session.amount_total,
          createdUnix: session.created,
        });
      } else {
        unmatchedUnpaid++;
      }
      continue;
    }
    if (session.payment_status !== "paid") continue;
    sessionCountByOrder.set(orderId, (sessionCountByOrder.get(orderId) ?? 0) + 1);
    if (!byOrder.has(orderId)) byOrder.set(orderId, session);
  }
  const multiSessionOrders = Array.from(sessionCountByOrder.entries())
    .filter(([, count]) => count > 1)
    .map(([orderId]) => orderId);
  console.error(`[stripe] scanned ${scanned} checkout sessions total`);
  console.error(
    `[stripe] ${unmatchedPaid.length} PAID sessions carry no metadata.id and cannot be ` +
      `matched to any order (${unmatchedUnpaid} more are unpaid/expired, so nothing was ` +
      `charged for those regardless)`
  );
  if (multiSessionOrders.length) {
    console.error(
      `[stripe] ${multiSessionOrders.length} order(s) have more than one paid session; ` +
        `the index keeps only the newest: ${multiSessionOrders.join(", ")}`
    );
  }
  return { byOrder, scanned, unmatchedPaid, unmatchedUnpaid, multiSessionOrders };
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

type UnsoundReason = "pre-cutover" | "israel-gap" | "other" | null;

type ClassifyResult = {
  row: ReportRow;
  countsStatus: ReportStatus;
  exactCents: number | null;
  reconstructedResidualCents: number | null;
  unsoundReason: UnsoundReason;
};

type ProductsOrderRow = InferSelectModel<typeof productsOrder>;
type OrdersRow = InferSelectModel<typeof orders>;

type ClassifyContext = {
  byOrder: Map<string, ProductsOrderRow[]>;
  orderMetaById: Map<string, OrdersRow>;
  sessionByOrder: Map<string, Stripe.Checkout.Session>;
  feeTable: FeeTable;
  /** Prefixed onto `line_labels` for a row that is not part of the primary
   *  all-same-product candidate set (R20's mixed-order addendum). */
  labelPrefix?: string;
};

/**
 * Classify ONE candidate order — same-product or mixed, the logic is
 * identical either way (R20 adds candidates, not new classification rules).
 * Shared by the primary 201 and the 4 mixed orders so there is exactly one
 * place this decision is made, not two copies that could drift apart.
 */
async function classifyCandidate(orderId: string, ctx: ClassifyContext): Promise<ClassifyResult> {
  const meta = ctx.orderMetaById.get(orderId);
  const orderNumber = meta?.orderNumber ?? "";
  const email = meta?.email ?? "";
  const prefix = ctx.labelPrefix ? [ctx.labelPrefix] : [];

  const session = ctx.sessionByOrder.get(orderId);
  if (!session) {
    return {
      row: { orderId, orderNumber, email, status: "no-session", differenceEur: "", lineLabels: prefix.join("; ") },
      countsStatus: "no-session",
      exactCents: null,
      reconstructedResidualCents: null,
      unsoundReason: null,
    };
  }

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 20 });
  const classification = classifySessionLines(lineItems.data);

  if (classification.status !== "indeterminate") {
    const exactCents =
      classification.status === "exact" && classification.differenceCents
        ? classification.differenceCents
        : null;
    return {
      row: {
        orderId,
        orderNumber,
        email,
        status: classification.status,
        differenceEur: exactCents ? (exactCents / 100).toFixed(2) : "",
        lineLabels: [...prefix, ...classification.labels].join("; "),
      },
      countsStatus: classification.status,
      exactCents,
      reconstructedResidualCents: null,
      unsoundReason: null,
    };
  }

  // --- R19: attempt to reconstruct the bundled fee ---------------------------
  const bundledLine = lineItems.data.find(
    (li) => (li.description ?? "").trim() === BUNDLED_FEE_LABEL_TRIMMED
  );
  const bundledCents = bundledLine?.amount_total ?? null;
  const lines = ctx.byOrder.get(orderId) ?? [];
  const basket = reconstructBasketFromLines(
    lines.map((l) => ({ action: l.action, price: l.price, quantity: l.quantity })),
    FALLBACK_ITEM_GRAMS
  );
  const zone = resolveZone(meta?.shippingCountry ?? null, meta?.shippingZip ?? null);
  const usedFallbackZone = !(zone && ctx.feeTable[zone]?.length);

  let status: ReportStatus = "indeterminate";
  let differenceEur = "";
  let reason = "";
  let unsoundReason: UnsoundReason = null;
  let reconstructedResidualCents: number | null = null;

  if (bundledCents == null) {
    unsoundReason = "other";
    reason = "no bundled fee amount found on the session";
  } else if (!basket.hasItems) {
    unsoundReason = "other";
    reason = "no active productsorder lines to reconstruct a basket from";
  } else if (meta?.returnMethod === "SELF") {
    // Defensive only: the self-booked lane (2026-08-24) postdates every
    // bundled-fee session by a month, so this should never actually fire.
    unsoundReason = "other";
    reason = "self-booked return — unexpected for a pre-itemisation session";
  } else if (
    !isReconstructionSound({ sessionCreatedUnix: session.created, zone, usedFallbackZone })
  ) {
    if (session.created < EXCHANGE_FEE_MODEL_CUTOVER_UNIX) {
      unsoundReason = "pre-cutover";
      reason =
        "before the exchange-fee-model cutover (commit 7919d72, first merged as d0ff03f / PR #14) — different rule, not reconstructable";
    } else {
      unsoundReason = "israel-gap";
      reason =
        `zone ${zone ?? "*"} priced between the exchange-fee-model cutover and the ` +
        `Israel repricing (commit 38aeb59 / PR #23) — current rate does not apply yet`;
    }
  } else {
    const bands = feesForCountry(ctx.feeTable, zone);
    const fee = resolveFee(sameZone(bands), basket);
    const residual = classifyResidual(bundledCents, fee.feeCents);
    status = residual.status;
    if (status === "reconstructed") reconstructedResidualCents = residual.residualCents;
    differenceEur = (residual.residualCents / 100).toFixed(2);
    reason =
      `reconstructed: expected €${(fee.feeCents / 100).toFixed(2)} ` +
      `(zone ${zone ?? "*"}, ${fee.kind}, ${basket.grams}g) vs charged ` +
      `€${(bundledCents / 100).toFixed(2)}`;
  }

  return {
    row: {
      orderId,
      orderNumber,
      email,
      status,
      differenceEur,
      lineLabels: [...prefix, ...classification.labels, reason].join("; "),
    },
    countsStatus: status,
    exactCents: null,
    reconstructedResidualCents,
    unsoundReason,
  };
}

function freshCounts(): Record<ReportStatus, number> {
  return {
    exact: 0,
    reconstructed: 0,
    "reconstructed-clean": 0,
    "reconstructed-undercharged": 0,
    indeterminate: 0,
    "no-charge": 0,
    "no-session": 0,
  };
}

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
  // R20: orders excluded from `candidates` (not ALL swaps same-product) but
  // holding at least one same-product swap line — the exact shape the
  // pre-branch ratio bug needed to mis-price a same-product line specifically.
  const mixedCandidates: string[] = [];
  let mixedSameProductLineCount = 0;

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
    if (isAllSameProductExchange(swaps, index)) {
      candidates.push(orderId);
    } else if (isMixedSameProductExchange(swaps, index)) {
      mixedCandidates.push(orderId);
      mixedSameProductLineCount += swaps.filter(
        (l) => index.productOf(l.new_variant_id) === String(l.productId)
      ).length;
    }
  }

  console.error(
    `[candidates] ${exchangeOrders} orders contain an exchange ` +
      `(${swapLineCount} CAMBIO lines with a chosen replacement, ` +
      `${sameProductLineCount} of those lines same-product); ` +
      `${candidates.length} orders are ALL-same-product exchanges`
  );
  console.error(
    `[mixed] ${mixedCandidates.length} orders excluded from the all-same-product set still ` +
      `hold a same-product swap line (${mixedSameProductLineCount} such lines total): ` +
      `${mixedCandidates.join(", ")}`
  );

  // --- Step 2: Stripe sessions, paginated once -----------------------------
  const sessionIndex = await buildSessionIndex();

  // --- Step 3: order metadata + fee table for every candidate --------------
  const allOrderIds = [...candidates, ...mixedCandidates];
  const orderMeta = allOrderIds.length
    ? await db.select().from(orders).where(inArray(orders.id, allOrderIds))
    : [];
  const orderMetaById = new Map(orderMeta.map((o) => [o.id, o]));
  const feeTable = await fetchFeeTable();

  const ctxBase = { byOrder, orderMetaById, sessionByOrder: sessionIndex.byOrder, feeTable };

  // --- Step 4: classify every primary candidate -----------------------------
  const results: ReportRow[] = [];
  const counts = freshCounts();
  // R19 sanity-check counters — reported alongside the CSV so a reader can
  // see WHY each unsound order was left indeterminate, not just that it was.
  let preCutoverCount = 0;
  let israelGapCount = 0;
  let otherUnsoundCount = 0;
  let exactTotalCents = 0;
  let reconstructedTotalCents = 0;
  // R20: which decidable (exact/no-charge) orders have more than one
  // productsorder row — the ONLY configuration the pre-branch
  // `applyGlobalDiscount` ratio bug could have mis-priced. Computed fresh
  // each run, not hardcoded.
  let decidableCount = 0;
  let decidableMultiLineCount = 0;

  for (const orderId of candidates) {
    const result = await classifyCandidate(orderId, ctxBase);
    counts[result.countsStatus]++;
    if (result.exactCents) exactTotalCents += result.exactCents;
    if (result.reconstructedResidualCents) reconstructedTotalCents += result.reconstructedResidualCents;
    if (result.unsoundReason === "pre-cutover") preCutoverCount++;
    if (result.unsoundReason === "israel-gap") israelGapCount++;
    if (result.unsoundReason === "other") otherUnsoundCount++;
    if (result.countsStatus === "exact" || result.countsStatus === "no-charge") {
      decidableCount++;
      if ((byOrder.get(orderId)?.length ?? 0) > 1) decidableMultiLineCount++;
    }
    results.push(result.row);
  }

  // --- Step 5: classify the 4 mixed orders as their own labelled addendum --
  const mixedResults: ReportRow[] = [];
  const mixedCounts = freshCounts();
  for (const orderId of mixedCandidates) {
    const swaps = (byOrder.get(orderId) ?? []).filter(
      (l) => l.action === "CAMBIO" && l.new_variant_id
    );
    const sameCount = swaps.filter(
      (l) => index.productOf(l.new_variant_id) === String(l.productId)
    ).length;
    const result = await classifyCandidate(orderId, {
      ...ctxBase,
      labelPrefix: `MIXED ORDER — ${sameCount} of ${swaps.length} swap lines same-product; NOT part of the 201 all-same-product candidates`,
    });
    mixedCounts[result.countsStatus]++;
    mixedResults.push(result.row);
  }

  // --- Output: CSV -----------------------------------------------------------
  console.log("order_id,order_number,email,status,difference_eur,line_labels");
  for (const r of [...results, ...mixedResults]) {
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

  // --- Output: summary ---------------------------------------------------------
  console.error("--- summary (201 all-same-product candidates) ---");
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

  console.error("--- summary (4 mixed orders, addendum, NOT counted above) ---");
  for (const status of REPORT_STATUSES) {
    if (mixedCounts[status]) console.error(`${status}: ${mixedCounts[status]}`);
  }

  // --- R20: THE POWER STATEMENT — prominent, not buried ------------------------
  console.error("");
  console.error("=".repeat(78));
  console.error("POWER OF THIS AUDIT (R20) — read before trusting the zero above");
  console.error("=".repeat(78));
  console.error(
    `decidable sample: ${decidableCount} of ${candidates.length} candidates ` +
      `(${preCutoverCount} pre-cutover bundled, ${counts["no-session"]} no paid session ` +
      `are NOT decidable by any method available here)`
  );
  console.error(
    `of those ${decidableCount}, only ${decidableMultiLineCount} have more than one ` +
      `productsorder row — the ONLY configuration the pre-fix applyGlobalDiscount ` +
      `ratio bug could have mis-priced (a single-line same-product exchange reproduces ` +
      `the paid price exactly, by construction, whether or not the bug was present)`
  );
  console.error(
    `THEREFORE: this audit's finding is "no overcharge provable among ` +
      `${decidableMultiLineCount} structurally-exposed orders", NOT "no overcharge occurred". ` +
      `A pre-cutover overcharge would be INVISIBLE to every method available to us.`
  );
  console.error(
    `no-session caveat: ${sessionIndex.unmatchedPaid.length} paid Stripe sessions carry no ` +
      `metadata.id and cannot be matched to any order (${sessionIndex.unmatchedUnpaid} more are ` +
      `unpaid/expired and genuinely charged nothing). Any matchable one would only ever add an ` +
      `indeterminate row (all predate the cutover), but "${counts["no-session"]} no-session = ` +
      `nothing was charged" is a lower bound, not a certainty — see the report for the breakdown.`
  );
  console.error("=".repeat(78));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
