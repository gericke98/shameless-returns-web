/**
 * Task 7 verification: order #311749 (Fran Cobo), read-only, against the
 * REAL production database and the REAL live Shopify catalogue.
 *
 * WHY A SCRIPT, NOT A COMMITTED TEST: this hits the production Postgres
 * database and the live Shopify Admin API over the network, using
 * DATABASE_URL / NEXT_PUBLIC_SHOP_URL / NEXT_PUBLIC_ACCESS_TOKEN from the
 * environment. A committed test under tests/ runs on every `vitest run` —
 * in CI (no such env vars, so it would simply fail) and on every other
 * developer's machine (where it WOULD have those vars, and would silently
 * make a real network call to the live store and prod DB on every test run
 * — slow, flaky, and a live-data dependency no unit suite should carry).
 * `scripts/audit-exchange-overcharges.ts` (Task 6) set this precedent for
 * the same reason. The pure logic this script exercises — valueBasket,
 * replacementPriceForVariant, resolveFee — already has full coverage in
 * tests/basket.test.ts, tests/replacementPricing.test.ts and
 * tests/fees.test.ts with fixtures, no network. This script's only job is
 * to prove those pure functions, wired to the ACTUAL data for THIS order,
 * produce EUR 0.00 — not to duplicate their unit tests.
 *
 * STRICTLY READ-ONLY: only `db.query.orders.findFirst` (a SELECT) and a
 * Shopify `products` query (a read). No `db.update`, no `db.insert`, no
 * Shopify mutation, no Stripe call. The order's OWN productsorder rows are
 * never written back — the CAMBIO override below happens only in a local
 * in-memory copy passed to valueBasket().
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/verify-311749-fix.ts \
 *     | tee .superpowers/sdd/2026-09-01-exchange-keeps-sale-price/verify-311749-fix.out
 */
import "dotenv/config";

import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders, shippingFees } from "@/db/schema";
import { valueBasket } from "@/lib/basket";
import {
  indexCatalogue,
  orderRatio,
  replacementPriceForVariant,
  type PricedLine,
} from "@/lib/replacementPricing";
import { feesForCountry, feesForWeight, resolveFee, sameZone, centsToEuros } from "@/lib/fees";
import { resolveZone } from "@/lib/zones";
import { defaultMethodFor, selfBookingOffered } from "@/lib/returnMethods";
import type { OrderItem, Product } from "@/types";

const ORDER_ID = "13282550841670";

// The smaller-size variants Fran wants, resolved by hand against the live
// catalogue (scripts/probe-catalogue-311749.ts, run separately, not
// committed): MENTALITY CREWNECK Large -> Medium, STAR AMALFI PANTS
// Large (42) -> Medium (40). Both are the size scale directly below the
// line's ORIGINAL variant, one step down, same product in both cases.
const SMALLER_SIZE: Record<string, string> = {
  "55598268973382": "gid://shopify/ProductVariant/55598268940614", // Crewneck Large -> Medium
  "54623384437062": "gid://shopify/ProductVariant/54623384404294", // Pants Large(42) -> Medium(40)
};

/** Mirrors db/queries.ts's getProducts() exactly (status:ACTIVE, grams via
 *  inventoryItem.measurement.weight) — NOT imported from there because that
 *  file is "use server" and several of its other exports are wrapped in
 *  React's cache(), which throws outside a Next request context the instant
 *  the module is evaluated (same reason scripts/audit-exchange-overcharges.ts
 *  reimplements it, see that file's module comment). */
async function fetchLiveCatalogue(): Promise<Product[]> {
  const url = `${process.env.NEXT_PUBLIC_SHOP_URL}/admin/api/graphql.json`;
  const query = `
    query getProducts {
      products(first: 250, query: "status:ACTIVE") {
        edges {
          node {
            id
            title
            handle
            description
            images(first: 1) { edges { node { url } } }
            variants(first: 50) {
              edges {
                node {
                  id
                  price
                  title
                  inventoryQuantity
                  inventoryItem { measurement { weight { value unit } } }
                }
              }
            }
          }
        }
      }
    }
  `;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": process.env.NEXT_PUBLIC_ACCESS_TOKEN!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const { data, errors } = await res.json();
  if (errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  const products: Product[] = data.products.edges.map(({ node }: { node: any }) => {
    for (const edge of node.variants?.edges ?? []) {
      edge.node.grams = toGrams(edge.node.inventoryItem?.measurement?.weight);
    }
    node.image = { src: node.images?.edges?.[0]?.node?.url ?? "" };
    return node;
  });
  return products;
}

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

/**
 * The OLD `applyGlobalDiscount` + `valueBasket`, computed HERE rather than
 * by resurrecting lib/basket.ts@35b2dc9 into the working tree (Task 7 brief
 * amendment). Reproduces the two functions verbatim from
 * `git show 35b2dc9:lib/basket.ts`.
 */
function oldExchangePrice(
  items: PricedLine[] & { new_variant_id: string | null }[],
  catalogue: Product[]
): { exchangePrice: number; ratio: number; perLine: { title: string; oldPrice: number }[] } {
  const first = items[0];
  let ratio = 1;
  if (first) {
    const firstCurrentProduct = catalogue.find(
      (p) => p.id.split("/").pop() === String(first.productId)
    );
    if (firstCurrentProduct) {
      const orderPrice = parseFloat(first.price);
      const currentPrice = parseFloat(firstCurrentProduct.variants.edges[0].node.price);
      if (currentPrice > 0) ratio = orderPrice / currentPrice;
    }
  }

  const perLine: { title: string; oldPrice: number }[] = [];
  let exchangePrice = 0;
  for (const item of items) {
    let price = parseFloat(item.price);
    if (item.new_variant_id) {
      const newProduct = catalogue.find((p) =>
        p.variants.edges.some((v) => v.node.id === item.new_variant_id)
      );
      const newVariant = newProduct?.variants.edges.find(
        (v) => v.node.id === item.new_variant_id
      );
      if (newVariant) {
        price = parseFloat((parseFloat(newVariant.node.price) * ratio).toFixed(2));
      }
    }
    exchangePrice += price;
    perLine.push({ title: (item as any).title, oldPrice: price });
  }
  return { exchangePrice, ratio, perLine };
}

async function main() {
  console.log("=== Task 7 verification: order #311749 (Fran Cobo) ===");
  console.log(`Run at ${new Date().toISOString()}, READ-ONLY against production.\n`);

  // ---- Load the REAL order + REAL productsorder rows ----------------------
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, ORDER_ID),
    with: { products: true },
  });
  if (!order) throw new Error(`Order ${ORDER_ID} not found`);

  console.log(`Order: ${order.orderNumber}  email=${order.email}`);
  console.log(
    `Shipping: ${order.shippingCity}, ${order.shippingProvince} ${order.shippingZip}, ${order.shippingCountry}\n`
  );

  console.log("REAL productsorder rows, as stored today:");
  for (const p of order.products) {
    console.log(
      `  [${p.id}] ${p.title} / ${p.variant_title}  variant_id=${p.variant_id}  ` +
        `price=${p.price}  action=${p.action}  new_variant_id=${p.new_variant_id}  confirmed=${p.confirmed}`
    );
  }
  console.log();

  // ---- Load the REAL live Shopify catalogue --------------------------------
  const catalogue = await fetchLiveCatalogue();
  console.log(`Fetched live catalogue: ${catalogue.length} ACTIVE products.\n`);

  // ---- Build the basket Fran WANTS: both lines CAMBIO, smaller size -------
  // Only the in-memory copy is mutated. Nothing is written back to the DB.
  const items: OrderItem[] = order.products.map((p) => {
    const newVariant = SMALLER_SIZE[p.variant_id];
    if (!newVariant) {
      throw new Error(`No smaller-size mapping for variant_id=${p.variant_id} (${p.title})`);
    }
    return {
      ...p,
      action: "CAMBIO",
      new_variant_id: newVariant,
      confirmed: false,
    } as OrderItem;
  });

  console.log("Basket under test: both lines set to CAMBIO, smaller size:");
  for (const item of items) {
    console.log(`  ${item.title} (${item.variant_title}) -> new_variant_id=${item.new_variant_id}`);
  }
  console.log();

  // ---- NEW code: lib/basket.ts valueBasket() (exactly what actions/payments.ts uses via loadBasket) ----
  const result = valueBasket(items, catalogue);

  const index = indexCatalogue(catalogue);
  const fallbackRatio = orderRatio(items as unknown as PricedLine[], index);
  console.log("=== NEW pricing (lib/replacementPricing.ts, shipped this branch) ===");
  const newPerLine: { title: string; paid: number; newPrice: number; basis: string }[] = [];
  for (const item of items) {
    const priced = replacementPriceForVariant(
      item as unknown as PricedLine,
      item.new_variant_id,
      index,
      fallbackRatio
    );
    newPerLine.push({
      title: `${item.title} (${item.variant_title})`,
      paid: parseFloat(item.price),
      newPrice: priced.price,
      basis: priced.basis,
    });
    console.log(
      `  ${item.title} (${item.variant_title}): paid=EUR ${parseFloat(item.price).toFixed(2)}  ` +
        `new replacement price=EUR ${priced.price.toFixed(2)}  basis=${priced.basis}`
    );
  }
  console.log(`  returnPrice = EUR ${result.returnPrice.toFixed(2)}`);
  console.log(`  exchangePrice = EUR ${result.exchangePrice.toFixed(2)}`);
  console.log(`  netAmount (NEW) = EUR ${result.netAmount.toFixed(2)}`);
  console.log(`  degraded = ${result.degraded}`);
  console.log(`  grams (parcel, original variants) = ${result.grams}\n`);

  // ---- OLD code: applyGlobalDiscount + valueBasket @ 35b2dc9 (reproduced, not resurrected) ----
  const old = oldExchangePrice(items as any, catalogue);
  const oldReturnPrice = items.reduce((sum, i) => sum + parseFloat(i.price), 0);
  const oldNetAmount = oldReturnPrice - old.exchangePrice;

  console.log("=== OLD pricing (applyGlobalDiscount @ commit 35b2dc9, reproduced here) ===");
  console.log(
    `  global discount ratio, derived from FIRST line (${items[0].title}): ` +
      `${parseFloat(items[0].price).toFixed(2)} / list = ${old.ratio.toFixed(6)}`
  );
  for (const line of old.perLine) {
    console.log(`  ${line.title}: old replacement price=EUR ${line.oldPrice.toFixed(2)}`);
  }
  console.log(`  returnPrice = EUR ${oldReturnPrice.toFixed(2)}`);
  console.log(`  exchangePrice (OLD) = EUR ${old.exchangePrice.toFixed(2)}`);
  console.log(`  netAmount (OLD) = EUR ${oldNetAmount.toFixed(2)}\n`);

  // ---- Assertion: NEW netAmount must be exactly 0 --------------------------
  if (result.netAmount !== 0) {
    console.error(`FAIL: expected NEW netAmount to be exactly 0, got ${result.netAmount}`);
    process.exitCode = 1;
  } else {
    console.log("PASS: NEW netAmount is exactly EUR 0.00.\n");
  }

  // ---- Step 2: what createStripeUrl would do, reasoned from the code -------
  console.log("=== Step 2: createStripeUrl reasoning (Spain, no live Stripe call) ===");
  const zone = resolveZone(order.shippingCountry, order.shippingZip);
  console.log(`  resolveZone("${order.shippingCountry}", "${order.shippingZip}") = "${zone}"`);

  const rows = await db.select().from(shippingFees);
  const table: Record<string, { maxGrams: number; returnFeeCents: number; exchangeFeeCents: number }[]> = {};
  for (const row of rows) {
    (table[row.countryCode] ??= []).push({
      maxGrams: row.maxGrams,
      returnFeeCents: row.returnFeeCents,
      exchangeFeeCents: row.exchangeFeeCents,
    });
  }
  for (const bands of Object.values(table)) bands.sort((a, b) => a.maxGrams - b.maxGrams);

  const bands = feesForCountry(table, zone);
  console.log(`  bands for zone "${zone}": ${JSON.stringify(bands)}`);

  const { feeCents, kind, returnLegCents, outboundLegCents } = resolveFee(sameZone(bands), result);
  console.log(
    `  resolveFee(grams=${result.grams}, netAmount=${result.netAmount}) => ` +
      `kind=${kind}  feeCents=${feeCents}  returnLegCents=${returnLegCents}  outboundLegCents=${outboundLegCents}`
  );

  const amphoraEnabled = process.env.AMPHORA_ENABLED === "true";
  const method = defaultMethodFor(order.shippingCountry, amphoraEnabled);
  console.log(`  defaultMethodFor("${order.shippingCountry}") = ${method}  (Spain is domestic, never AMPHORA)`);
  console.log(`  selfBookingOffered(returnLegCents=${returnLegCents}) = ${selfBookingOffered(returnLegCents)}`);

  const selfBooked = method === "SELF";
  const chargeCents = selfBooked ? outboundLegCents : feeCents;
  const totalEuros = result.netAmount - centsToEuros(chargeCents);
  const amountCents = Math.round(-totalEuros * 100);

  console.log(`  chargeCents (method=${method}) = ${chargeCents}`);
  console.log(`  totalEuros = netAmount(${result.netAmount}) - centsToEuros(chargeCents=${chargeCents}) = ${totalEuros.toFixed(2)}`);
  if (totalEuros >= 0) {
    console.log(`  createStripeUrl(...) => { data: null }  (totalEuros >= 0, no payment required)`);
  } else if (amountCents < 50) {
    console.log(`  createStripeUrl(...) => { data: null }  (amountCents=${amountCents} below Stripe's 50c minimum)`);
  } else {
    console.log(`  createStripeUrl(...) => creates a Stripe session for EUR ${centsToEuros(amountCents).toFixed(2)}`);
  }
  console.log(`  What Fran would see: EUR ${centsToEuros(chargeCents).toFixed(2)} return shipping/exchange fee, EUR 0.00 price difference.\n`);

  console.log("=== Done ===");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
