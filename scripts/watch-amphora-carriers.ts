/**
 * Watch international returns that Amphora has approved but never assigned a
 * carrier to — the failure mode behind order #310957.
 *
 * A return we create through the Company API (`external_id` set) reaches
 * APROVED with a warehouse and a full collection address, and then stops: no
 * `carrier`, no `carrier_number`, no collection ever scheduled. The customer has
 * paid for a pickup that was never booked, and nothing in our own database
 * shows it — `orders.carrier` is simply null, which is also what "booked five
 * minutes ago" looks like. Measured 2026-07-30: 77 of 78 returns created by
 * Amphora's own Shopify channel had a carrier; 0 of 5 created by us did.
 *
 * Run it to answer two questions at once:
 *   1. has a carrier landed on any of the stranded returns yet?
 *   2. are the escalation tickets still open?
 *
 *   npx tsx scripts/watch-amphora-carriers.ts
 *   npx tsx scripts/watch-amphora-carriers.ts --stale-hours 4
 *
 * Read-only: it performs GETs plus the documented `tickets/get` POST, and
 * creates, approves and cancels nothing.
 *
 * Credentials come from the environment, falling back to the shameless-agent
 * .env where the Amphora keys already live (they are not in this project's
 * Vercel env — see the memory note on Amphora integration).
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { join } from "path";
import { matchReturnsToOrderIds } from "../lib/amphoraReturnMatch";
import { isInternationalOrder } from "../lib/countries";

const AGENT_ENV = join(
  process.env.HOME ?? "",
  "Proyectos/1_Shameless/shameless-agent/.env"
);

function credential(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(AGENT_ENV, "utf8").split("\n")) {
      if (line.startsWith(`${name}=`)) return line.slice(name.length + 1).trim();
    }
  } catch {
    // fall through to the error below — a missing file and a missing key are
    // the same problem from the caller's point of view.
  }
  throw new Error(
    `${name} is not set and was not found in ${AGENT_ENV}. Export it or run from a shell that has it.`
  );
}

const API_KEY = credential("AMPHORA_API_KEY");
const TENANT = credential("AMPHORA_TENANT_ID");
const BASE =
  process.env.AMPHORA_COMPANY_API_URL ||
  "https://api.amphoralogistics.com/prod-integrations-api";

type AmphoraReturn = {
  id: string;
  name: string | null;
  external_id: string | null;
  internal_status: string;
  carrier: string | null;
  carrier_number: string | null;
  carrier_url: string | null;
  time: string | null;
  time_approved: string | null;
};

async function amphora<T>(
  path: string,
  init?: { method: "POST"; body: unknown }
): Promise<T> {
  const res = await fetch(`${BASE}/${encodeURIComponent(TENANT)}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
      ...(init ? { "Content-Type": "application/json" } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Hours since an Amphora timestamp, or null when it never happened. */
function hoursSince(stamp: string | null): number | null {
  if (!stamp) return null;
  // Amphora sends both bare local times and offset-aware ones; treat a bare
  // stamp as UTC rather than as the machine's zone, so this reads the same on a
  // laptop in Madrid and in CI.
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

async function ticketOpen(orderName: string): Promise<boolean | null> {
  try {
    const body = await amphora<any>("/tickets/get", {
      method: "POST",
      body: { entity_id: orderName },
    });
    const rows: any[] = body?.tickets ?? body?.data ?? (Array.isArray(body) ? body : []);
    const ours = rows.filter((t) => t?.subcategory === "order chn_ret");
    if (ours.length === 0) return null;
    return ours.some((t) => t?.is_closed === false);
  } catch {
    return null;
  }
}

/** Our orders for the given ids, keyed by id. Read-only.
 *
 * `locator` comes back too: holding one means we already emailed this customer
 * their tracking, so the operator must not be told to email them again. */
async function ordersById(
  ids: string[]
): Promise<Map<string, { shipping_country: string; locator: string | null }>> {
  // Validate DATABASE_URL unconditionally, even when ids is empty. If Amphora's
  // /returns call is malformed or returns no matches, a missing credential should
  // fail loud (exit 2) rather than silent (exit 0 with "API-created returns: 0").
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This script now resolves ownership against our own orders table — export it or add it to .env."
    );
  }
  if (ids.length === 0) return new Map();
  const sql = neon(url);
  const rows = (await sql`
    select id, shipping_country, locator from orders where id = any(${ids})
  `) as Array<{ id: string; shipping_country: string; locator: string | null }>;
  return new Map(
    rows.map((r) => [
      r.id,
      { shipping_country: r.shipping_country, locator: r.locator ?? null },
    ])
  );
}

async function main() {
  const flag = process.argv.indexOf("--stale-hours");
  const staleHours = flag > -1 ? Number(process.argv[flag + 1]) : 2;

  const body = await amphora<{ return_orders?: AmphoraReturn[]; returns?: AmphoraReturn[] }>(
    "/returns"
  );
  const all = body.return_orders ?? body.returns ?? [];

  // Everything that refers to one of our orders, whether we created it or
  // Amphora re-created it in their UI (which nulls `external_id`).
  const matched = matchReturnsToOrderIds(all);
  const orders = await ordersById(matched.map((m) => m.orderId));

  // A match with no order row is dropped from every section below. Before this
  // script resolved ownership against our database it listed API-created returns
  // unconditionally, so silence here would be a regression in the one tool built
  // to make stranded returns VISIBLE. Say so out loud instead.
  const unresolved = matched.filter((m) => !orders.get(m.orderId));

  // The SAME ownership rule the cron applies: international, and in our
  // database. (The cron additionally requires a confirmed line item for an
  // orphan; this script has no join to productsorder, so it over-reports
  // slightly rather than hiding anything.)
  //
  // An earlier revision skipped the database and simply over-reported, on the
  // theory that showing too much is safer than hiding a stranded return. In
  // production that printed 77 rows, 74 of them under "notify these customers",
  // including 2025-era Spanish CEX/CAI/DHL returns that never touched our
  // portal. Burying three stranded returns under 74 irrelevant ones fails this
  // script's only job just as completely as hiding them would.
  const owned = matched.filter((m) => {
    const order = orders.get(m.orderId);
    if (!order) return false;
    // Applied to API-created returns too, not just orphans: we only ever create
    // Amphora returns for international orders, so this rejects nothing real,
    // and it stops the report leaning on Amphora never setting external_id.
    return isInternationalOrder(order.shipping_country);
  });
  const ours = owned.map((m) => m.ret);
  const recreated = new Set(owned.filter((m) => !m.viaExternalId).map((m) => m.ret));
  // Do we already hold tracking for this order? If so the customer has already
  // had the email and must not be listed as someone to notify.
  const notified = new Set(
    owned.filter((m) => orders.get(m.orderId)?.locator?.trim()).map((m) => m.ret)
  );
  const assigned = ours.filter((r) => r.carrier);
  const stranded = ours
    .filter((r) => !r.carrier && !["CANCELLED", "FINISHED"].includes(r.internal_status))
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  console.log(
    `Our returns: ${ours.length} · with a carrier: ${assigned.length} · stranded: ${stranded.length}\n`
  );

  if (unresolved.length) {
    console.log(
      `⚠️  ${unresolved.length} Amphora return(s) match one of our order ids but have NO row in our orders table — investigate, they are excluded from everything below:`
    );
    for (const m of unresolved) {
      console.log(
        `  ${m.ret.name ?? "(no name)"}  ${m.ret.id}  ` +
          `order id ${m.orderId}  ${m.viaExternalId ? "created by us (external_id)" : "orphan"}`
      );
    }
    console.log();
  }

  // Split on whether we already hold the tracking. Amphora emails the label
  // directly to the customer when they assign the carrier themselves, and the
  // sync cron writes the locator and emails on our side — so a return we hold a
  // locator for has ALREADY been communicated. Listing it under "notify these
  // customers" invites a duplicate email, which is how all seven backfilled
  // orders would have been double-notified.
  const toNotify = assigned.filter((r) => !notified.has(r));
  const alreadyNotified = assigned.filter((r) => notified.has(r));

  const line = (r: AmphoraReturn) =>
    `  ${r.name}  ${r.carrier}  ${r.carrier_number ?? "(no number)"}  ${r.carrier_url ?? ""}` +
    (recreated.has(r) ? "  [re-created by Amphora]" : "");

  if (toNotify.length) {
    console.log("CARRIER ASSIGNED — collection is booked, notify these customers:");
    for (const r of toNotify) console.log(line(r));
    console.log();
  }

  if (alreadyNotified.length) {
    console.log(
      "CARRIER ASSIGNED — ALREADY NOTIFIED (we hold the locator, do NOT email again):"
    );
    for (const r of alreadyNotified) console.log(line(r));
    console.log();
  }

  for (const r of stranded) {
    // Both ages, because they diverge and the customer only feels one of them:
    // #310761 was created 24/07 but not approved until 30/07, so "hours since
    // approval" reads as fresh while the customer has been waiting six days.
    const sinceCreated = hoursSince(r.time);
    const waited = hoursSince(r.time_approved ?? r.time);
    const fmt = (h: number | null) =>
      h === null ? "?" : h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
    const open = await ticketOpen(r.name ?? "");
    const ticket =
      open === null ? "NO TICKET" : open ? "ticket open" : "ticket CLOSED with no carrier";
    const alarm = waited !== null && waited > staleHours ? " <-- STALE" : "";
    console.log(
      `  ${r.name}  ${r.internal_status}  customer waiting ${fmt(sinceCreated)} ` +
        `(${fmt(waited)} since approval)  ${ticket}${alarm}`
    );
  }

  // Exit non-zero when something needs a human, so this can be run on a
  // schedule and only speak up when it matters.
  const needsAttention = stranded.some((r) => {
    const waited = hoursSince(r.time_approved ?? r.time);
    return waited !== null && waited > staleHours;
  });
  if (needsAttention) {
    console.log(
      `\n${stranded.length} return(s) approved with no carrier past ${staleHours}h — collections are not booked.`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("watch-amphora-carriers failed:", err?.message ?? err);
  process.exitCode = 2;
});
