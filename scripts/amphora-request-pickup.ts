/**
 * Ask Amphora to collect a stranded international return on a given date.
 *
 * Amphora will not book a courier for an API-created return until a human tells
 * them a day and a time slot — `POST /returns` has no field for one, so every
 * return we create sits APROVED with no carrier until someone opens a ticket
 * and asks (see scripts/watch-amphora-carriers.ts for who is stranded). They
 * told us on 2026-08-03 that a pickup needs **three days' notice**, so the date
 * you pass has to clear that or it is refused silently.
 *
 * One open ticket is allowed per (type, order): this replies on the existing
 * thread when there is one and opens a new one when there is not, so it is safe
 * to re-run over the same orders.
 *
 *   npx tsx scripts/amphora-request-pickup.ts --date "jueves 6 de agosto" --dry-run '#310761'
 *   npx tsx scripts/amphora-request-pickup.ts --date "jueves 6 de agosto" '#310761' '#310905'
 *
 * The collection address is read from Amphora's own return record rather than
 * our DB, so what we quote them is what they already hold.
 *
 * Writes: `tickets/add_message` and `tickets/create`, nothing else. Both are
 * one-way — a sent message cannot be unsent — so --dry-run prints the exact
 * payloads first.
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

/** The only company_user Amphora accepts for us — a personal address 422s. */
const COMPANY_USER = "hello@shamelesscollective.com";

type AmphoraReturn = {
  id: string;
  name: string | null;
  external_id: string | null;
  internal_status: string;
  carrier: string | null;
  time: string | null;
  shipping_address: string | null;
  shipping_address2: string | null;
  shipping_address_city: string | null;
  shipping_address_country_code: string | null;
  shipping_address_zip: string | null;
  shipping_address_name: string | null;
  customer_phone: string | null;
};

type Ticket = {
  order_name?: string;
  zendesk_id?: string;
  subcategory?: string;
  is_closed?: boolean;
  /** Amphora's ticket id for add_message; `gap` and `legacy_gap` hold it. */
  gap?: string;
  legacy_gap?: string;
};

async function amphora<T>(
  path: string,
  init?: { method: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${BASE}/${encodeURIComponent(TENANT)}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const days = (stamp: string | null) => {
  if (!stamp) return null;
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
};

/** One line an Amphora operator can hand straight to a courier. */
function collectionAddress(r: AmphoraReturn): string {
  const street = [r.shipping_address, r.shipping_address2].filter(Boolean).join(", ");
  return (
    `${r.shipping_address_name} — ${street}, ${r.shipping_address_zip} ` +
    `${r.shipping_address_city} (${r.shipping_address_country_code})` +
    (r.customer_phone ? `. Tel: ${r.customer_phone}` : "")
  );
}

function reply(r: AmphoraReturn, date: string, slot: string, waiting: number, stranded: number) {
  return (
    `Hola Adrián,\n\n` +
    `Entendido lo de los tres días de antelación. Entonces la recogida del lunes 3 ` +
    `queda anulada y os pedimos la de ${r.name} para el **${date}, franja ${slot}**.\n\n` +
    `Recogida en: ${collectionAddress(r)}\n\n` +
    `Necesitamos que nos lo confirméis por escrito antes de avisar al cliente: ya le ` +
    `dijimos una fecha que no se cumplió y lleva ${waiting} días esperando. Si el ` +
    `${date} no fuera posible, decidnos la primera fecha que sí lo sea y no la ` +
    `comunicamos hasta tenerla vuestra.\n\n` +
    `Y seguimos sin respuesta a la pregunta de proceso, que es la que haría que ` +
    `dejarais de recibir estos tickets: ¿cómo os indicamos el día y la franja de ` +
    `recogida por API? En POST /returns no existe ningún campo para ello. Mientras no ` +
    `lo haya, cada devolución internacional nueva se queda APROVED sin transportista: ` +
    `ya van ${stranded}, la última #310986 del 1 de agosto.\n\n` +
    `Gracias.`
  );
}

function opener(r: AmphoraReturn, date: string, slot: string, waiting: number, stranded: number) {
  return (
    `Buenos días,\n\n` +
    `La devolución ${r.id} (pedido ${r.name}, ${r.shipping_address_country_code}) está ` +
    `APROVED desde el ${String(r.time).slice(0, 10)} con almacén 10 y dirección completa, ` +
    `pero carrier / carrier_number / carrier_url siguen a null: no hay recogida ` +
    `programada y el cliente lleva ${waiting} días esperando. Es el mismo caso que los ` +
    `tickets ya abiertos para #310761, #310972, #310905, #310928 y #310957 — ` +
    `creada por la Company API (POST /returns) sin carrier_data, es decir no es una ` +
    `devolución externa, así que el transportista lo tenéis que asignar vosotros.\n\n` +
    `Nos habéis indicado que la recogida necesita tres días de antelación, así que la ` +
    `pedimos para el **${date}, franja ${slot}**.\n\n` +
    `Recogida en: ${collectionAddress(r)}\n\n` +
    `Confirmádnoslo por escrito, por favor, antes de que avisemos al cliente.\n\n` +
    `Y la pregunta de fondo: ¿cómo os indicamos día y franja de recogida por API? En ` +
    `POST /returns no hay campo para ello, y por eso se nos quedan todas paradas — ya ` +
    `van ${stranded}.\n\n` +
    `Gracias.`
  );
}

/**
 * Short follow-up asking them to confirm a date we already asked for. Separate
 * from `reply()` because once the customer has been told the date, the only
 * thing we need back is a yes or a different date — restating the whole case
 * buries that.
 */
function chase(r: AmphoraReturn, date: string, slot: string) {
  return (
    `Hola Adrián,\n\n` +
    `¿Nos confirmáis por escrito la recogida de ${r.name} ` +
    `(${r.shipping_address_name}, ${r.shipping_address_city}) para el ` +
    `**${date}, franja ${slot}**?\n\n` +
    `Os lo pedimos hoy porque ya le hemos comunicado esa fecha al cliente. Si el ` +
    `${date} no fuera posible, decidnos hoy la primera fecha que sí lo sea para ` +
    `poder avisarle con tiempo.\n\n` +
    `Gracias.`
  );
}

/**
 * Ask them to apply the fix they already applied. On 2026-08-05 Amphora
 * enabled an auto-assign profile setting and re-created seven stranded returns
 * with UPS carriers; these were created before the flip and were not on that
 * list. The three-days-notice argument is settled, so this deliberately does
 * NOT re-open it — the only ask is parity with the seven.
 */
function reassign(r: AmphoraReturn, waiting: number) {
  return (
    `Hola,\n\n` +
    `Gracias por habilitar la asignación automática de transportista y por volver ` +
    `a crear las siete devoluciones con carrier — lo hemos verificado y todas ` +
    `tienen ya su número de UPS.\n\n` +
    `Esta devolución no estaba en esa lista porque se creó justo antes de ` +
    `que lo habilitarais, y sigue APROVED sin transportista:\n\n` +
    `  · ${r.id} (pedido ${r.name}, ${r.shipping_address_country_code}), creada el ` +
    `${String(r.time).slice(0, 10)}, ${waiting === 1 ? "1 día" : `${waiting} días`} esperando.\n\n` +
    `Recogida en: ${collectionAddress(r)}\n\n` +
    `¿Podéis darle el mismo tratamiento que a las otras siete? No hace falta que ` +
    `nos confirméis fecha: en cuanto tengan carrier y número lo vemos por API.\n\n` +
    `Gracias.`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const chasing = argv.includes("--chase");
  const reassigning = argv.includes("--reassign");
  const value = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : fallback;
  };
  const date = value("--date", "");
  const slot = value("--slot", "09:00-18:00");
  const orders = argv.filter(
    (a, i) => !a.startsWith("--") && !["--date", "--slot"].includes(argv[i - 1])
  );

  if (!date && !reassigning) throw new Error(`--date is required, e.g. --date "jueves 6 de agosto"`);
  if (orders.length === 0) throw new Error("pass at least one order, e.g. '#310761'");

  const body = await amphora<{ return_orders?: AmphoraReturn[]; returns?: AmphoraReturn[] }>(
    "/returns"
  );
  const all = body.return_orders ?? body.returns ?? [];
  // Counts ONLY returns we created through the Company API (`external_id` set)
  // that are still carrier-less. It is deliberately NOT the number
  // watch-amphora-carriers.ts prints: that script resolves ownership against our
  // orders table and so also counts the ones Amphora re-created in their UI,
  // which carry no external_id. This script has no database access, and adding
  // one to align them is not worth it — but the difference matters, because this
  // number is interpolated into ticket text and ticket writes are one-way: they
  // vanish from the merchant UI permanently, so a wrong figure cannot be
  // corrected afterwards. Under-counting is the safe direction.
  const stranded = all.filter(
    (r) => r.external_id && !r.carrier && !["CANCELLED", "FINISHED"].includes(r.internal_status)
  ).length;

  for (const order of orders) {
    const r = all.find((x) => x.name === order);
    if (!r) {
      console.log(`\n${order}: no Amphora return found — skipped`);
      continue;
    }
    const waiting = Math.round(days(r.time) ?? 0);

    const got = await amphora<{ tickets?: Ticket[] }>("/tickets/get", {
      method: "POST",
      body: { entity_id: order },
    });
    const open = (got.tickets ?? []).find(
      (t) => t.subcategory === "order chn_ret" && !t.is_closed
    );

    if (chasing && !open) {
      console.log(`\n${order}: no open ticket to chase — skipped`);
      continue;
    }

    const action = open ? "add_message" : "create";
    const ticketId = open?.gap ?? open?.legacy_gap;
    const message = reassigning
      ? reassign(r, waiting)
      : chasing
        ? chase(r, date, slot)
        : open
          ? reply(r, date, slot, waiting, stranded)
          : opener(r, date, slot, waiting, stranded);

    console.log(`\n${"═".repeat(100)}\n${order}  →  tickets/${action}` +
      (open ? `  (zendesk ${open.zendesk_id}, id "${ticketId}")` : "  (new thread)") +
      `\n${"═".repeat(100)}\n${message}`);

    if (dryRun) continue;

    if (open) {
      if (!ticketId) {
        console.log(`  ⚠️  open ticket has no id field — cannot reply, skipped`);
        continue;
      }
      await amphora("/tickets/add_message", {
        method: "POST",
        body: { id: ticketId, message, user: COMPANY_USER },
      });
      console.log(`  ✔ replied on zendesk ${open.zendesk_id}`);
    } else {
      const created = await amphora<{ ticket_id?: string }>("/tickets/create", {
        method: "POST",
        body: {
          ticket_type: "order",
          subcategory: "order chn_ret",
          message,
          order_id: order,
          company_user: { email: COMPANY_USER },
        },
      });
      console.log(`  ✔ opened ticket ${created.ticket_id ?? "(id not returned)"}`);
    }
  }
}

main().catch((e) => {
  console.error("amphora-request-pickup failed:", e?.message ?? e);
  process.exitCode = 1;
});
