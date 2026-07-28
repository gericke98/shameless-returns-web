# Return tariff

How `data/return-tariff.csv` — the prices customers are charged to return an
order — is produced, and how to change it.

## The rule

**The fee is the carrier's own price for that zone and weight, rounded up to
the whole euro.** Nothing is banded, anchored or subsidised.

That is a deliberate choice, not an accident of implementation. An earlier
version grouped destinations into four price tiers and then added the
carrier's weight increment on top. It produced orderings that made no sense —
AE cost €66.95 at 2kg and was charged €42, while MX cost €66.35 and was
charged €46 — because the tiering flattened cost before the increments were
added. Charging cost directly removes the whole class of bug: `ceil` is
monotonic, so a heavier parcel is never cheaper than a lighter one and a
costlier destination is never cheaper than a cheaper one. Both are asserted in
`tests/shippingFeeCoverage.test.ts`.

**An exchange is charged for two journeys**, because it is two — the parcel
back and the replacement out. `exchange fee = return fee + outbound delivery`,
where the outbound leg comes from `data/outbound-rates.csv`.

That file is produced by `outbound.mjs` from the store's own delivery profiles,
which is the most defensible basis available: it is exactly what any customer
pays to receive a garment, so an exchange ends up costing the same as returning
and reordering. Shopify does not know the carrier's wholesale cost, so nothing
here is that.

FX is not fetched from a rate API. Every order carries its shipping in both
presentment and shop currency, so Shopify has already converted at transaction
time; `outbound.mjs` takes the median ratio across recent orders. Re-running it
refreshes the rates. A currency the store has never taken an order in has no
conversion available, so that destination falls back to the most expensive
outbound rate — the same worst-case principle as the `*` fee row.

## Files

| | |
|---|---|
| `tarifas.xlsx` | The carrier tariff, exactly as it produced the current prices. Two tabs: `Tarifas Devoluciones Terrestre` (ground) and `Tarifas Devoluciones Aéreo` (air). |
| `emit_bands.py` | Regenerates `data/return-tariff.csv` from it. Reads `data/outbound-rates.csv` for the exchange leg, so run `outbound.mjs` first if delivery prices changed. |
| `outbound.mjs` | Pulls outbound delivery prices and FX from Shopify into `data/outbound-rates.csv`. |
| `destinations.mjs` | Lists every country that has actually received an order, with volume — the input to "are we missing a destination?" |

## Repricing after the carrier republishes

1. **Refresh `tarifas.xlsx`.** The source is a Google Sheet owned by
   `events@shamelesscollective.com`. Export it as **xlsx**, not CSV — Google's
   CSV export silently returns only the *active* sheet, so you get the ground
   tab alone and no error. Save over `scripts/tariff/tarifas.xlsx`.

2. `python3 scripts/tariff/emit_bands.py`

3. `npm test` — the coverage tests fail if a destination lost its unbounded
   band, a fee fell below cost, a heavier band got cheaper, or a country in the
   storefront dropdown went unpriced.

4. `npx tsx scripts/seed-shipping-fees-by-country.ts --dry-run`, read it, then
   run it without the flag.

`git diff data/return-tariff.csv` is the price change, reviewable line by line.

## Adding a destination

`emit_bands.py` **reprices existing destinations; it does not discover new
ones.** Which carrier zone a country belongs to is a judgement call rather than
something derivable from the workbook, so that mapping lives in the CSV itself.

To add one: append a single row by hand with the right `country_code` and
`zone` (the zone name must match a row in one of the two tabs), then re-run the
script — it will expand that into the full set of weight bands. Add the country
to `SUPPORTED_COUNTRIES` in `lib/countries.ts` too, or the coverage test will
fail for being priced but not selectable.

Run `node scripts/tariff/destinations.mjs` to see which countries actually
receive orders. That is how Uruguay was found shipping while missing from the
dropdown.

## Known data issues in the sheet

- A **`Macao`** row sits in the *ground* tier at €12.50 among Austria, Poland
  and Greece. There is no ground route from Spain to Macao and the air tariff
  would put it near €52 — almost certainly a typo for **Mónaco**. It is
  excluded from the CSV either way; neither has ever received an order.
- **Andorra** appears in neither tab, so it falls through to the `*` fallback,
  which is the most expensive fee at each band. It borders Spain and would
  realistically be cheap. Zero orders so far; worth a quote before the first.
