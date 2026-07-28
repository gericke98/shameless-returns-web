// Extract outbound delivery rates from Shopify into data/outbound-rates.csv.
//
// An exchange is TWO journeys — the customer's parcel back, and the
// replacement out — so it costs the return leg plus a delivery. The return leg
// comes from the carrier tariff (scripts/tariff/emit_bands.py); this is the
// other half.
//
// The rate used is the store's own published delivery price for that zone,
// which is the most defensible basis available: it is exactly what any
// customer pays to receive a garment, so an exchange ends up costing the same
// as returning and reordering. Nothing here is the carrier's wholesale cost —
// Shopify does not know it.
//
// FX is not fetched from a rate API. Every order carries its shipping in both
// presentment and shop currency, so Shopify has already converted at
// transaction time; the median ratio across recent orders is used. That keeps
// the number sourced from real transactions and refreshed by re-running this,
// rather than drifting behind a hardcoded constant.
//
// Run from the repo root, with Shopify credentials in the environment:
//   vercel env pull .env.tariff && set -a && . ./.env.tariff && set +a
//   node scripts/tariff/outbound.mjs
import fs from "node:fs";
import path from "node:path";

const shop = process.env.NEXT_PUBLIC_SHOP_URL;
const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
if (!shop || !token) {
  console.error("NEXT_PUBLIC_SHOP_URL and NEXT_PUBLIC_ACCESS_TOKEN must be set.");
  process.exit(1);
}
const endpoint = `https://${shop.replace(/^https?:\/\//, "").replace(/\/$/, "")}/admin/api/2025-01/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL error:", JSON.stringify(json.errors).slice(0, 400));
    process.exit(1);
  }
  return json.data;
}

// --- 1. FX, from Shopify's own conversions on real orders -------------------

const FX_QUERY = `query($cursor: String) {
  orders(first: 250, after: $cursor, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      totalShippingPriceSet {
        shopMoney { amount currencyCode }
        presentmentMoney { amount currencyCode }
      }
    }
  }
}`;

const samples = new Map();
let cursor = null;
let shopCurrency = "EUR";
for (let page = 0; page < 12; page++) {
  const { orders } = await gql(FX_QUERY, { cursor });
  for (const order of orders.nodes) {
    const shopMoney = order.totalShippingPriceSet?.shopMoney;
    const local = order.totalShippingPriceSet?.presentmentMoney;
    if (!shopMoney || !local) continue;
    shopCurrency = shopMoney.currencyCode;
    const from = Number(local.amount);
    const to = Number(shopMoney.amount);
    if (!(from > 0) || !(to > 0) || local.currencyCode === shopMoney.currencyCode) continue;
    if (!samples.has(local.currencyCode)) samples.set(local.currencyCode, []);
    samples.get(local.currencyCode).push(to / from);
  }
  if (!orders.pageInfo.hasNextPage) break;
  cursor = orders.pageInfo.endCursor;
}

// Median, not mean: a single order with an odd shipping line (a manual
// adjustment, a partial refund) would drag an average and not a median.
const fx = new Map([[shopCurrency, 1]]);
for (const [currency, ratios] of samples) {
  ratios.sort((a, b) => a - b);
  fx.set(currency, ratios[Math.floor(ratios.length / 2)]);
}

// --- 2. Delivery rates ------------------------------------------------------

const RATES_QUERY = `query {
  deliveryProfiles(first: 5) {
    nodes {
      profileLocationGroups {
        locationGroupZones(first: 100) {
          nodes {
            zone { name countries { code { countryCode } } }
            methodDefinitions(first: 10) {
              nodes {
                active
                rateProvider { ... on DeliveryRateDefinition { price { amount currencyCode } } }
              }
            }
          }
        }
      }
    }
  }
}`;

// Countries that sit in several delivery zones. Shopify splits Spain the same
// way the return tariff does, so the mapping is stated rather than guessed —
// a first-match join silently picks Canarias for ES and the Azores for PT.
const ZONE_FOR = {
  ES: "España Peninsular",
  "ES-IB": "España - Islas",
  "ES-CN": "España - Canarias",
  // Ceuta and Melilla have no delivery zone of their own. They are the dearest
  // Spanish destination on the return side, so they take the dearest Spanish
  // outbound rate rather than the peninsular one.
  "ES-CM": "España - Canarias",
  PT: "Portugal",
};

const data = await gql(RATES_QUERY);
const byZoneName = new Map();
const firstForCountry = new Map();
for (const profile of data.deliveryProfiles.nodes) {
  for (const group of profile.profileLocationGroups) {
    for (const zone of group.locationGroupZones.nodes) {
      const method = zone.methodDefinitions.nodes.find((m) => m.active && m.rateProvider?.price);
      if (!method) continue;
      const price = method.rateProvider.price;
      byZoneName.set(zone.zone.name, price);
      for (const country of zone.zone.countries) {
        const code = country.code?.countryCode;
        if (code && !firstForCountry.has(code)) firstForCountry.set(code, [zone.zone.name, price]);
      }
    }
  }
}

function rateFor(key) {
  const named = ZONE_FOR[key];
  if (named) {
    const price = byZoneName.get(named);
    if (!price) throw new Error(`delivery zone "${named}" not found for ${key}`);
    return [named, price];
  }
  return firstForCountry.get(key) ?? null;
}

// --- 3. Emit ----------------------------------------------------------------

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const tariff = fs.readFileSync(path.join(ROOT, "data", "return-tariff.csv"), "utf8");
const destinations = Array.from(
  new Set(tariff.trim().split("\n").slice(1).map((l) => l.split(",")[0]))
).sort();

const rows = [];
const unconverted = [];
for (const code of destinations) {
  const found = rateFor(code);
  if (!found) {
    unconverted.push([code, "", "", "", "no delivery zone"]);
    continue;
  }
  const [zoneName, price] = found;
  const rate = fx.get(price.currencyCode);
  if (!rate) {
    // A currency we have never taken an order in, so Shopify has never
    // converted it for us. Deferred to the fallback below rather than dropped:
    // a destination with no outbound rate would price an exchange as if the
    // replacement shipped for free.
    unconverted.push([code, zoneName, price.amount, price.currencyCode, `no FX for ${price.currencyCode}`]);
    continue;
  }
  rows.push([code, zoneName, price.amount, price.currencyCode, Math.round(Number(price.amount) * rate * 100)]);
}

// Worst case, same principle as the '*' fee row: an unconvertible destination
// should announce itself, not quietly ship a replacement at our expense.
const fallback = Math.max(...rows.map((r) => r[4]));
for (const [code, zoneName, amount, currency, why] of unconverted) {
  rows.push([code, zoneName || "(none)", amount || "", currency || "", fallback]);
  console.log(`fallback ${fallback} cents for ${code}: ${why}`);
}
rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const out = ["country_code,delivery_zone,amount,currency,eur_cents", ...rows.map((r) => r.join(","))];
fs.writeFileSync(path.join(ROOT, "data", "outbound-rates.csv"), out.join("\n") + "\n");
console.log(`FX (1 unit -> ${shopCurrency}), median of real orders:`);
for (const [currency, rate] of [...fx].sort()) {
  if (currency !== shopCurrency) {
    console.log(`  ${currency} = ${rate.toFixed(4)}  (n=${samples.get(currency).length})`);
  }
}
console.log(`\nwrote ${rows.length} destinations -> data/outbound-rates.csv`);
