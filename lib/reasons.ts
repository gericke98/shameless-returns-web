import { type Dictionary } from "@/lib/i18n";
import { REASON_KEYS, type ReasonKey } from "@/placeholder";

const REASON_KEY_SET: ReadonlySet<string> = new Set<string>(REASON_KEYS);

// Before the value/label split, productsOrder.reason held the Spanish sentence
// shown in the dropdown. Those rows still exist, so map them back to their key
// instead of treating them as unknown.
//
// FROZEN ON PURPOSE. These are the ten literal strings the pre-split dropdown
// wrote to the column (`REASONS` in placeholder.ts as of 072f4dc^), copied
// byte for byte, accents included. They are historical data, not copy.
//
// This was previously derived from `dictionaries.es.reasons` — the live
// display dictionary. That coupled decoding to wording: rephrasing a Spanish
// reason, an ordinary copy edit now that the UI is translated, would stop
// every legacy row from decoding. Each would fall to the default and, on the
// next save, persist a reason the customer never gave. Do not "tidy" these
// strings and do not point this map back at the dictionary; edit es.ts freely
// instead, which is the whole point of the split.
const LEGACY_ES_LABEL_TO_KEY: ReadonlyMap<string, ReasonKey> = new Map<
  string,
  ReasonKey
>([
  ["Me queda grande", "TOO_BIG"],
  ["Me queda pequeño", "TOO_SMALL"],
  ["Es incómodo o me hace daño", "UNCOMFORTABLE"],
  ["No me gusta", "DISLIKE"],
  ["Compré varias opciones para probar", "BOUGHT_OPTIONS"],
  ["El producto está dañado", "DAMAGED"],
  ["Recibí el producto equivocado", "WRONG_ITEM"],
  ["El producto llegó demasiado tarde", "LATE"],
  ["Otro motivo", "OTHER"],
  ["El producto no es como se mostraba", "NOT_AS_SHOWN"],
]);

export function isReasonKey(value: string): value is ReasonKey {
  return REASON_KEY_SET.has(value);
}

/**
 * Coerce a stored `productsOrder.reason` to a stable key so the reason
 * <select> always has a matching option. Without this, re-opening a legacy row
 * would show a select whose value matches no option and could silently submit
 * a different reason.
 *
 * Two different "we don't know" cases, deliberately answered differently:
 *
 *  - No stored reason at all (null / "") — nothing has been claimed yet, and
 *    the dialog's specified default is TOO_SMALL. `fallback` covers this.
 *  - A stored value we cannot decode — the customer *did* state a reason and
 *    we failed to read it. Answering TOO_SMALL here asserts something they
 *    never said, and updateOrder then writes it back. OTHER is the honest
 *    answer and is already a first-class key.
 */
export function toReasonKey(
  stored: string | null | undefined,
  fallback: ReasonKey = "TOO_SMALL"
): ReasonKey {
  if (!stored) return fallback;
  if (isReasonKey(stored)) return stored;
  return LEGACY_ES_LABEL_TO_KEY.get(stored) ?? "OTHER";
}

/**
 * Display text for a stored reason: localized when the value is a known key
 * (or a known legacy Spanish sentence), otherwise the raw stored string so an
 * unrecognised value renders as-is rather than blank.
 */
export function reasonLabel(stored: string, t: Dictionary): string {
  if (isReasonKey(stored)) return t.reasons[stored];
  const legacyKey = LEGACY_ES_LABEL_TO_KEY.get(stored);
  return legacyKey ? t.reasons[legacyKey] : stored;
}
