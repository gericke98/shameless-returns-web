// Every country that has actually received an order, with volume.
//
// The input to "are we missing a destination?" — the tariff has to cover
// everything this prints. Running it is how Uruguay was found shipping while
// absent from SUPPORTED_COUNTRIES, so it could not be selected in the portal.
//
// Read-only against the Shopify Admin GraphQL API.
//
// Run from the repo root, with the Shopify credentials in the environment:
//   vercel env pull .env.tariff && set -a && . ./.env.tariff && set +a
//   node scripts/tariff/destinations.mjs
import fs from "node:fs";
import path from "node:path";

const shop = process.env.NEXT_PUBLIC_SHOP_URL;
const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
if (!shop || !token) {
  console.error(
    "NEXT_PUBLIC_SHOP_URL and NEXT_PUBLIC_ACCESS_TOKEN must be set — see the header of this file."
  );
  process.exit(1);
}

const endpoint = `https://${shop.replace(/^https?:\/\//, "").replace(/\/$/, "")}/admin/api/2025-01/graphql.json`;

const QUERY = `
  query($cursor: String) {
    orders(first: 250, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { shippingAddress { countryCodeV2 } }
    }
  }`;

const PAGES = Number(process.env.PAGES ?? 12); // 250 orders each
const counts = new Map();
let cursor = null;
let scanned = 0;

for (let page = 0; page < PAGES; page++) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: QUERY, variables: { cursor } }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("GraphQL error:", JSON.stringify(json.errors).slice(0, 300));
    process.exit(1);
  }
  const { nodes, pageInfo } = json.data.orders;
  for (const node of nodes) {
    const code = node.shippingAddress?.countryCodeV2;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    scanned++;
  }
  if (!pageInfo.hasNextPage) break;
  cursor = pageInfo.endCursor;
}

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`scanned=${scanned} destinations=${sorted.length}`);
console.log(sorted.map(([code, n]) => `${code}:${n}`).join(" "));

// Cross-check against what the tariff actually prices. Sub-zones (ES-CN and
// friends) are compared on their parent country — they are resolved from a
// postcode, not chosen by the customer.
const csv = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "data", "return-tariff.csv"),
  "utf8"
);
const priced = new Set(
  csv.trim().split("\n").slice(1).map((line) => line.split(",")[0].split("-")[0])
);
const unpriced = sorted.filter(([code]) => !priced.has(code));
console.log(
  unpriced.length
    ? `\nSHIPPING BUT UNPRICED: ${unpriced.map(([c, n]) => `${c} (${n})`).join(", ")}`
    : "\nevery destination with orders is priced"
);
