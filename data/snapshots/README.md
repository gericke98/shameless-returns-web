# shipping_fees snapshots

Exact contents of the `shipping_fees` table immediately **before** each
production write on 2026-07-28, oldest first. They are the rollback targets for
those changes, and the record of what customers were actually charged at each
point.

| File | Rows | State it captures |
|---|---:|---|
| `fees_before.csv` | 2 | The original flat rate. `*` and `ES` only, both 500/400, so every international destination was billed the Spanish domestic rate. |
| `fees_before_bands.csv` | 44 | After per-country pricing and the `max_grams` migration, before weight bands existed — every row still the unbounded band. |
| `fees_before_zones.csv` | 220 | After weight bands, before Spain's islands and enclaves were split out of the peninsular rate. |

To roll back to one of these, truncate `shipping_fees` and `\copy` the file
back in — the columns are in table order. Check `db/schema.ts` first: these
predate nothing today, but a future migration would make the column list stale.

The forward path is the opposite direction and usually the better one: fix
`data/return-tariff.csv` (see `scripts/tariff/README.md`) and re-run
`scripts/seed-shipping-fees-by-country.ts`, which upserts.
