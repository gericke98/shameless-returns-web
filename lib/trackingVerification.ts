// Does the carrier know this exact tracking number? Pure verdicts over what
// each carrier answers, so the rules are pinned by tests against real
// responses (captured 2026-11-24, see tests/trackingVerification.test.ts).
//
// Why: Amphora pins `carrier_number` WRITE-ONCE at approve, and the warehouse
// matches parcels by it. #311595 and #313127 sent their order number and
// Amphora pinned it. A number reaches Amphora only once it is verified
// (docs/superpowers/plans/2026-11-24-verify-tracking-before-pin.md).
//
// A verdict can only CONFIRM a number:
//  - "verified":   the carrier answered about THIS number, and it exists;
//  - "unknown":    the carrier answered, and says it has no such number;
//  - "unreadable": anything else (an error, a layout or shape we do not
//                  recognise). Never read as either of the above: the caller
//                  sends it to ops, it neither refuses nor approves.

export type Verdict = "verified" | "unknown" | "unreadable";

/** Which carriers we can ask. Named on the carrier (lib/carriers `verify`). */
export type Verifier = "correos" | "nacex" | "bpost";

const same = (a: unknown, b: string) =>
  typeof a === "string" && a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();

/**
 * Correos localizador (`eventos_envio_servicio_auth`). It answers for any
 * Correos parcel, including ones customers post themselves.
 *
 * ⚠️ It also matches REFERENCES: asked for `313127` it returns a different
 * parcel (`codEnvio 6330003413121560`, `numReferencia1 "313127"`). So the
 * answer counts only when `codEnvio` is the number we asked about.
 */
export function correosVerdict(payload: unknown, trackingNumber: string): Verdict {
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first || typeof first !== "object") return "unreadable";
  const record = first as Record<string, any>;
  // Every answer carries `error`; success is `{"codError":"0","desError":""}`.
  const code = record.error == null ? "0" : String(record.error.codError);
  // "3": "Sin Trazabilidad en Minerva" — Correos has no such parcel.
  if (code === "3") return "unknown";
  if (code !== "0") return "unreadable";
  if (!same(record.codEnvio, trackingNumber)) return "unknown";
  return Array.isArray(record.eventos) && record.eventos.length > 0 ? "verified" : "unreadable";
}

/**
 * NACEX `seguimientoDetalle.do`: server-rendered HTML, served as ISO-8859-1.
 * Matched on ASCII-only markers so the encoding cannot move them.
 */
export function nacexVerdict(
  html: string,
  parts: { agency: string; note: string }
): Verdict {
  const table = /<table[^>]*id="tabla_estado"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (table) {
    const shown = /<b>\s*([^<]+?)\s*<\/b>/i.exec(table)?.[1];
    const status = /class="fuente_titulo[^"]*"[^>]*>\s*([^<]+?)\s*</i.exec(table)?.[1];
    if (shown === `${parts.agency}/${parts.note}` && status) return "verified";
    return "unreadable";
  }
  if (/No existe ning/.test(html)) return "unknown";
  return "unreadable";
}

/** bpost public tracking JSON (`track.bpost.cloud/track/items`). */
export function bpostVerdict(payload: unknown, trackingNumber: string): Verdict {
  if (!payload || typeof payload !== "object") return "unreadable";
  const body = payload as Record<string, any>;
  if (body.error === "NO_DATA_FOUND") return "unknown";
  if (!Array.isArray(body.items)) return "unreadable";
  return body.items.some((i: any) => same(i?.itemCode, trackingNumber) || same(i?.searchCode, trackingNumber))
    ? "verified"
    : "unreadable";
}
