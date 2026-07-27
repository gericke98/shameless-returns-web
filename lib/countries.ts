// The single source of truth for "what country is this string".
//
// Three interpretations previously coexisted: COUNTRY_NAME_TO_ISO2 in
// sendcloudReturn.ts, an inline lowercase compare in isInternationalOrder,
// and a "spain" | "españa" check in actions/order.ts. They are all replaced
// by normalizeCountry().
//
// Pure module — must not import from db/ or any server-only code, because
// client components import it for the country dropdown.

export type Country = {
  /** ISO 3166-1 alpha-2, uppercase. */
  code: string;
  nameEs: string;
  nameEn: string;
};

export const SUPPORTED_COUNTRIES: readonly Country[] = [
  { code: "ES", nameEs: "España", nameEn: "Spain" },
  { code: "AT", nameEs: "Austria", nameEn: "Austria" },
  { code: "BE", nameEs: "Bélgica", nameEn: "Belgium" },
  { code: "BG", nameEs: "Bulgaria", nameEn: "Bulgaria" },
  { code: "HR", nameEs: "Croacia", nameEn: "Croatia" },
  { code: "CY", nameEs: "Chipre", nameEn: "Cyprus" },
  { code: "CZ", nameEs: "República Checa", nameEn: "Czech Republic" },
  { code: "DK", nameEs: "Dinamarca", nameEn: "Denmark" },
  { code: "EE", nameEs: "Estonia", nameEn: "Estonia" },
  { code: "FI", nameEs: "Finlandia", nameEn: "Finland" },
  { code: "FR", nameEs: "Francia", nameEn: "France" },
  { code: "DE", nameEs: "Alemania", nameEn: "Germany" },
  { code: "GR", nameEs: "Grecia", nameEn: "Greece" },
  { code: "HU", nameEs: "Hungría", nameEn: "Hungary" },
  { code: "IE", nameEs: "Irlanda", nameEn: "Ireland" },
  { code: "IT", nameEs: "Italia", nameEn: "Italy" },
  { code: "LV", nameEs: "Letonia", nameEn: "Latvia" },
  { code: "LT", nameEs: "Lituania", nameEn: "Lithuania" },
  { code: "LU", nameEs: "Luxemburgo", nameEn: "Luxembourg" },
  { code: "MT", nameEs: "Malta", nameEn: "Malta" },
  { code: "NL", nameEs: "Países Bajos", nameEn: "Netherlands" },
  { code: "PL", nameEs: "Polonia", nameEn: "Poland" },
  { code: "PT", nameEs: "Portugal", nameEn: "Portugal" },
  { code: "RO", nameEs: "Rumanía", nameEn: "Romania" },
  { code: "SK", nameEs: "Eslovaquia", nameEn: "Slovakia" },
  { code: "SI", nameEs: "Eslovenia", nameEn: "Slovenia" },
  { code: "SE", nameEs: "Suecia", nameEn: "Sweden" },

  // --- Non-EU destinations. -------------------------------------------------
  // This list is NOT a menu the customer picks from — the address form renders
  // the stored country read-only. It is the set of countries the app can name
  // and price *by ISO-2 code*. A country missing from here still works: it
  // routes internationally (isInternationalOrder) and falls back to the '*' fee
  // row; it just displays as its raw stored string and cannot have a per-country
  // fee row. Andorra was the concrete gap.
  //
  // Adding a row here does NOT create an EU lane: EU_ISO2 below is a separate,
  // fixed list and is the only thing euIso2ForReturn consults.
  { code: "AD", nameEs: "Andorra", nameEn: "Andorra" },
  { code: "GB", nameEs: "Reino Unido", nameEn: "United Kingdom" },
  { code: "CH", nameEs: "Suiza", nameEn: "Switzerland" },
  { code: "NO", nameEs: "Noruega", nameEn: "Norway" },
  { code: "IS", nameEs: "Islandia", nameEn: "Iceland" },
  { code: "US", nameEs: "Estados Unidos", nameEn: "United States" },
  { code: "CA", nameEs: "Canadá", nameEn: "Canada" },
  { code: "MX", nameEs: "México", nameEn: "Mexico" },
  { code: "BR", nameEs: "Brasil", nameEn: "Brazil" },
  { code: "AR", nameEs: "Argentina", nameEn: "Argentina" },
  { code: "CL", nameEs: "Chile", nameEn: "Chile" },
  { code: "CO", nameEs: "Colombia", nameEn: "Colombia" },
  { code: "IL", nameEs: "Israel", nameEn: "Israel" },
  { code: "AE", nameEs: "Emiratos Árabes Unidos", nameEn: "United Arab Emirates" },
  { code: "JP", nameEs: "Japón", nameEn: "Japan" },
  { code: "AU", nameEs: "Australia", nameEn: "Australia" },
] as const;

/** EU member states, excluding Spain (national/Correos). Used by the
 *  Sendcloud EU-only lane check.
 *
 *  Exactly 26 entries — the 27 member states minus Spain. This is NOT derived
 *  from SUPPORTED_COUNTRIES and must never be: SUPPORTED_COUNTRIES is the
 *  "what can the customer pick" list and includes non-EU destinations, while
 *  this is the "is this an EU shipping lane" list. Adding a country to the
 *  dropdown must not silently enrol it in the EU lane. */
export const EU_ISO2: Set<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "SE",
]);

const VALID_CODES = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));

/** Strip combining diacritical marks and lowercase. */
const stripAccents = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Lowercased display name (ES and EN) -> ISO-2. Includes unaccented
 *  variants because historical rows contain "Espana". */
const NAME_TO_ISO2: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const c of SUPPORTED_COUNTRIES) {
    map[c.nameEn.toLowerCase()] = c.code;
    map[c.nameEs.toLowerCase()] = c.code;
    map[stripAccents(c.nameEn)] = c.code;
    map[stripAccents(c.nameEs)] = c.code;
  }
  // Aliases seen in historical Shopify data.
  map["czechia"] = "CZ";
  map["esp"] = "ES";
  map["holland"] = "NL";
  map["uk"] = "GB";
  map["great britain"] = "GB";
  map["usa"] = "US";
  map["united states of america"] = "US";
  return map;
})();

/**
 * Resolve any stored or user-supplied country string to a supported ISO-2
 * code, or null if it is empty or unrecognised. Callers decide what null
 * means: the fee resolver falls back to the "*" default row; the shipment
 * router treats it as international.
 */
export function normalizeCountry(
  input: string | null | undefined
): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (raw.length === 2) {
    const upper = raw.toUpperCase();
    if (VALID_CODES.has(upper)) return upper;
  }

  const stripped = stripAccents(raw);
  return NAME_TO_ISO2[raw.toLowerCase()] ?? NAME_TO_ISO2[stripped] ?? null;
}

const BY_CODE: ReadonlyMap<string, Country> = new Map(
  SUPPORTED_COUNTRIES.map((c) => [c.code, c] as const)
);

/** The country row for an ISO-2 code, or null when it is not one we can name. */
export function countryByCode(code: string | null | undefined): Country | null {
  if (!code) return null;
  return BY_CODE.get(code) ?? null;
}

/**
 * How to show a stored `orders.shippingCountry` to the customer.
 *
 * Localized display name when the stored value resolves to a supported code,
 * otherwise the raw stored string. It must never invent a country: an Andorra
 * order reads "Andorra", never "España".
 */
export function countryDisplayName(
  stored: string | null | undefined,
  locale: "es" | "en"
): string {
  const country = countryByCode(normalizeCountry(stored));
  if (country) return locale === "en" ? country.nameEn : country.nameEs;
  return String(stored ?? "").trim();
}
