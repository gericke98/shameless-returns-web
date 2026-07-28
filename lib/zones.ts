// Which row of shipping_fees a delivery address falls in.
//
// `country_code` in shipping_fees is really a ZONE key, not strictly an ISO-2
// country. For almost every destination the two coincide. Spain is the
// exception: it is one country but five carrier zones, and the spread is not
// small — a return from Tenerife costs EUR 21.15 and one from Ceuta EUR 44.59,
// against EUR 4.01 from Madrid. Charging all of them the peninsular rate was
// the largest remaining gap after per-country pricing, and it sits inside the
// market that is 46% of all orders.
//
// Pure module: no db, no env, no server-only imports, so client components can
// resolve the same zone the server charges from.
import { normalizeCountry } from "./countries";

/**
 * Spanish postal prefixes that leave the peninsular zone.
 *
 * Two digits is all the carrier tariff can actually distinguish. Each Canarian
 * province holds both a major island and minor ones, and 07 covers Mallorca as
 * well as Menorca, Ibiza and Formentera, so a finer split would need 3-digit
 * ranges. Where a prefix spans two tariff rows, data/return-tariff.csv carries
 * the more expensive one — see the note there. Anything not listed is
 * peninsular.
 */
const ES_ZONE_BY_PREFIX: Readonly<Record<string, string>> = {
  "07": "ES-IB", // Illes Balears
  "35": "ES-CN", // Las Palmas
  "38": "ES-CN", // Santa Cruz de Tenerife
  "51": "ES-CM", // Ceuta
  "52": "ES-CM", // Melilla
};

/** Zone keys that are not plain ISO-2 country codes. */
export const SUB_ZONES = Object.freeze(["ES-IB", "ES-CN", "ES-CM"] as const);

/** Every zone key is either an ISO-2 code, the '*' fallback, or COUNTRY-XX. */
export const ZONE_KEY_PATTERN = /^(\*|[A-Z]{2}(-[A-Z]{2})?)$/;

/**
 * The fee-table key for a delivery address.
 *
 * Returns null for a country we cannot name, exactly as `normalizeCountry`
 * does — callers already treat that as "use the '*' row".
 *
 * A Spanish address with a missing or unparseable postal code resolves to
 * peninsular. That is the cheapest Spanish zone, so it can undercharge, but
 * the alternative is guessing an island from nothing: 477 of 489 Spanish
 * orders are peninsular, and a customer must not be billed an island rate
 * because their postcode failed to parse.
 *
 * KNOWN GAP: `shipping_zip` is customer-editable through `updateData`, so a
 * customer in Tenerife can enter a Madrid postcode and be charged EUR 5
 * instead of EUR 22. This is the same shape as the hole deliberately closed
 * for `shippingCountry`, which the address form renders read-only precisely
 * because it decides carrier and price — but the postcode has to stay
 * editable, since it is also where the return label is sent.
 *
 * Not mitigated here: the exposure is 12 of 489 Spanish orders, and the only
 * sound fix is a separate immutable column holding the postcode as it was at
 * purchase, which is a migration. `shipping_province` is not a usable
 * cross-check — it is editable through the same form.
 */
export function resolveZone(
  country: string | null | undefined,
  postalCode: string | null | undefined
): string | null {
  const code = normalizeCountry(country);
  if (code !== "ES") return code;

  const digits = String(postalCode ?? "").replace(/\D/g, "");
  // Spanish postal codes are five digits and the leading zero is significant —
  // Balearic codes start 07. Systems that store them as numbers drop it, so a
  // four-digit value is padded rather than read as a 4x prefix (which would
  // silently bill Mallorca at the peninsular rate).
  const normalised = digits.length === 4 ? `0${digits}` : digits;
  if (normalised.length !== 5) return "ES";

  return ES_ZONE_BY_PREFIX[normalised.slice(0, 2)] ?? "ES";
}
