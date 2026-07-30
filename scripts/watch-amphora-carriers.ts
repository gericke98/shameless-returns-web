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
import { readFileSync } from "fs";
import { join } from "path";

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

async function main() {
  const flag = process.argv.indexOf("--stale-hours");
  const staleHours = flag > -1 ? Number(process.argv[flag + 1]) : 2;

  const body = await amphora<{ return_orders?: AmphoraReturn[]; returns?: AmphoraReturn[] }>(
    "/returns"
  );
  const all = body.return_orders ?? body.returns ?? [];

  // Only the ones WE created. Amphora's own Shopify-channel returns carry a
  // null external_id and are not ours to chase.
  const ours = all.filter((r) => r.external_id);
  const assigned = ours.filter((r) => r.carrier);
  const stranded = ours
    .filter((r) => !r.carrier && !["CANCELLED", "FINISHED"].includes(r.internal_status))
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));

  console.log(
    `API-created returns: ${ours.length} · with a carrier: ${assigned.length} · stranded: ${stranded.length}\n`
  );

  if (assigned.length) {
    console.log("CARRIER ASSIGNED — collection is booked, notify these customers:");
    for (const r of assigned) {
      console.log(
        `  ${r.name}  ${r.carrier}  ${r.carrier_number ?? "(no number)"}  ${r.carrier_url ?? ""}`
      );
    }
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
