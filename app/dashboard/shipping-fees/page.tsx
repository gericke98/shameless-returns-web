import { getFeeTable } from "@/db/fees";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type CountryBands } from "@/lib/fees";
import { FeesTable } from "./FeesTable";

export const dynamic = "force-dynamic";

/** Postal-code zones within Spain, in the order ops would expect to read them. */
const SUB_ZONE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["ES-IB", "Spain — Balearic Islands (07)"],
  ["ES-CN", "Spain — Canary Islands (35, 38)"],
  ["ES-CM", "Spain — Ceuta & Melilla (51, 52)"],
];

/** "≤ 1 kg" / "> 5 kg" — the band's upper bound, in the units ops thinks in. */
function bandLabel(maxGrams: number, previousMaxGrams: number | null) {
  if (maxGrams >= UNBOUNDED_MAX_GRAMS) {
    return previousMaxGrams === null
      ? "any weight"
      : `> ${(previousMaxGrams / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
  }
  return `≤ ${(maxGrams / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
}

export default async function ShippingFeesPage() {
  const table = await getFeeTable();
  const fallback = table[DEFAULT_FEE_KEY] ?? [];

  // One row per (country, band). A country with no bands of its own shows the
  // default's bands, marked inherited, so ops can see what it is actually
  // charging rather than a blank.
  const rowsFor = (
    countryCode: string,
    label: string,
    bands: CountryBands,
    hasRow: boolean
  ) =>
    bands.map((band, i) => ({
      countryCode,
      maxGrams: band.maxGrams,
      label: i === 0 ? label : "",
      bandLabel: bandLabel(band.maxGrams, i === 0 ? null : bands[i - 1].maxGrams),
      returnFeeCents: band.returnFeeCents,
      exchangeFeeCents: band.exchangeFeeCents,
      hasRow,
    }));

  const rows = [
    ...rowsFor(
      DEFAULT_FEE_KEY,
      "Default (all other countries)",
      fallback,
      fallback.length > 0
    ),
    ...SUPPORTED_COUNTRIES.flatMap((c) =>
      rowsFor(
        c.code,
        `${c.nameEn} (${c.code})`,
        table[c.code]?.length ? table[c.code] : fallback,
        Boolean(table[c.code]?.length)
      )
    ),
    // Spanish sub-zones. Not in SUPPORTED_COUNTRIES because a customer never
    // picks them — they are resolved from the postal code of a Spanish
    // address. Without these rows the ops table would silently omit the most
    // expensive destinations in the country.
    ...SUB_ZONE_LABELS.flatMap(([zone, label]) =>
      rowsFor(zone, label, table[zone]?.length ? table[zone] : fallback, Boolean(table[zone]?.length))
    ),
  ];

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">Shipping fees</h1>
      <p className="mt-2 text-sm text-gray-600">
        Amounts charged to the customer for a return or an exchange, by
        destination country and parcel weight. Countries left as{" "}
        <span className="font-semibold">inherited</span> use the default rows.
        Changes apply immediately — no deploy needed.
      </p>
      <p className="mt-1 text-sm text-gray-600">
        Weight is the parcel the customer ships back, summed from the catalogue
        weight of the items they selected. Editing a band here changes only that
        band.
      </p>
      <FeesTable rows={rows} />
    </main>
  );
}
