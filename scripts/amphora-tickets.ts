/**
 * Read Amphora support threads from the terminal.
 *
 * Needed because tickets our integration touches are invisible in Amphora's
 * merchant UI: `ticket.source` latches to `api` on first API contact and never
 * reverts, and the Tickets view lists only `source: go`. Zendesk 903378 was
 * visible until one `add_message` flipped it. So every thread this codebase
 * opens or replies to disappears from the dashboard the moment it matters —
 * including the five stranded-collection escalations.
 *
 *   npx tsx scripts/amphora-tickets.ts                    # the stranded returns
 *   npx tsx scripts/amphora-tickets.ts '#310884' '#310580'
 *   npx tsx scripts/amphora-tickets.ts --all              # sweep our order book
 *
 * Read-only: the documented tickets/get POST and nothing else.
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
    /* fall through */
  }
  throw new Error(`${name} not set and not found in ${AGENT_ENV}`);
}

const API_KEY = credential("AMPHORA_API_KEY");
const TENANT = credential("AMPHORA_TENANT_ID");
const BASE =
  process.env.AMPHORA_COMPANY_API_URL ||
  "https://api.amphoralogistics.com/prod-integrations-api";

/** Escalations opened for the returns Amphora never assigned a carrier to. */
const STRANDED = ["#310761", "#310972", "#310905", "#310928", "#310957"];

type Message = {
  date?: string;
  side?: string;
  source?: string;
  user?: string;
  message?: string;
};
type Ticket = {
  zendesk_id?: number;
  order_name?: string;
  source?: string;
  subcategory?: string;
  is_closed?: boolean;
  amphora_assigned?: string;
  messages?: Message[];
};

async function tickets(entityId: string): Promise<Ticket[]> {
  const res = await fetch(`${BASE}/${encodeURIComponent(TENANT)}/tickets/get`, {
    method: "POST",
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { tickets?: Ticket[] };
  return body.tickets ?? [];
}

const wrap = (text: string, indent: string) =>
  text
    .trim()
    .split("\n")
    .flatMap((line) => line.match(/.{1,96}(\s|$)/g) ?? [line])
    .map((l) => indent + l.trim())
    .join("\n");

async function main() {
  const argv = process.argv.slice(2);
  let entities = argv.filter((a) => !a.startsWith("--"));

  if (argv.includes("--all")) {
    // No list-all endpoint exists; tickets are only reachable by entity, so
    // sweep the order book. Slow but it is the only way to find them.
    const { default: db } = await import("@/db/drizzle");
    const rows = await db.query.orders.findMany({ columns: { orderNumber: true } });
    entities = rows.map((r: any) => r.orderNumber).filter(Boolean);
    console.log(`sweeping ${entities.length} orders…\n`);
  }
  if (entities.length === 0) entities = STRANDED;

  let awaitingThem = 0;

  for (const entity of entities) {
    for (const t of await tickets(entity)) {
      const msgs = t.messages ?? [];
      const last = msgs[msgs.length - 1];
      // Who owes a reply. `side: amphora` last means the ball is with us.
      const ball = last?.side === "amphora" ? "OUR MOVE" : "waiting on Amphora";
      if (last?.side !== "amphora" && !t.is_closed) awaitingThem += 1;

      console.log(
        `\n${"═".repeat(100)}\n` +
          `${t.order_name}   zendesk ${t.zendesk_id}   ${t.subcategory}   ` +
          `${t.is_closed ? "CLOSED" : ball}\n` +
          `assigned: ${t.amphora_assigned ?? "unassigned"}   ` +
          `source: ${t.source}${t.source === "api" ? "  (hidden from the Amphora UI)" : ""}\n` +
          `${"═".repeat(100)}`
      );

      for (const m of msgs) {
        const who = m.side === "amphora" ? `AMPHORA  ${m.user ?? ""}` : `us       ${m.user ?? ""}`;
        console.log(`\n  [${String(m.date).slice(0, 19).replace("T", " ")}]  ${who}`);
        console.log(wrap(m.message ?? "", "      "));
      }
    }
  }

  console.log(
    `\n\n${awaitingThem} open thread(s) waiting on Amphora. ` +
      `Threads where the last word is theirs need a reply from us.`
  );
}

main().catch((e) => {
  console.error("amphora-tickets failed:", e?.message ?? e);
  process.exitCode = 1;
});
