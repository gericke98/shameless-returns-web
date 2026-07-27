import { getFeeTable } from "@/db/fees";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { DEFAULT_FEE_KEY } from "@/lib/fees";
import { FeesTable } from "./FeesTable";

export const dynamic = "force-dynamic";

export default async function ShippingFeesPage() {
  const table = await getFeeTable();

  const rows = [
    {
      countryCode: DEFAULT_FEE_KEY,
      label: "Default (all other countries)",
      returnFeeCents: table[DEFAULT_FEE_KEY]?.returnFeeCents ?? 0,
      exchangeFeeCents: table[DEFAULT_FEE_KEY]?.exchangeFeeCents ?? 0,
      hasRow: Boolean(table[DEFAULT_FEE_KEY]),
    },
    ...SUPPORTED_COUNTRIES.map((c) => ({
      countryCode: c.code,
      label: `${c.nameEn} (${c.code})`,
      returnFeeCents: table[c.code]?.returnFeeCents ?? table[DEFAULT_FEE_KEY]?.returnFeeCents ?? 0,
      exchangeFeeCents:
        table[c.code]?.exchangeFeeCents ?? table[DEFAULT_FEE_KEY]?.exchangeFeeCents ?? 0,
      hasRow: Boolean(table[c.code]),
    })),
  ];

  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">Shipping fees</h1>
      <p className="mt-2 text-sm text-gray-600">
        Amounts charged to the customer for a return or an exchange, by
        destination country. Countries left as{" "}
        <span className="font-semibold">inherited</span> use the default row.
        Changes apply immediately — no deploy needed.
      </p>
      <FeesTable rows={rows} />
    </main>
  );
}
