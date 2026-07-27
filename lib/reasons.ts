import { dictionaries, type Dictionary } from "@/lib/i18n";
import { REASON_KEYS, type ReasonKey } from "@/placeholder";

const REASON_KEY_SET: ReadonlySet<string> = new Set<string>(REASON_KEYS);

// Before the value/label split, productsOrder.reason held the Spanish sentence
// shown in the dropdown. Those rows still exist, so map them back to their key
// instead of treating them as unknown.
const LEGACY_ES_LABEL_TO_KEY: ReadonlyMap<string, ReasonKey> = new Map(
  REASON_KEYS.map((key) => [dictionaries.es.reasons[key], key] as const)
);

export function isReasonKey(value: string): value is ReasonKey {
  return REASON_KEY_SET.has(value);
}

/**
 * Coerce a stored `productsOrder.reason` to a stable key so the reason
 * <select> always has a matching option. Without this, re-opening a legacy row
 * would show a select whose value matches no option and could silently submit
 * a different reason.
 */
export function toReasonKey(
  stored: string | null | undefined,
  fallback: ReasonKey = "TOO_SMALL"
): ReasonKey {
  if (!stored) return fallback;
  if (isReasonKey(stored)) return stored;
  return LEGACY_ES_LABEL_TO_KEY.get(stored) ?? fallback;
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
