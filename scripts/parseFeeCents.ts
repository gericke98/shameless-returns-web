// Pure parsing helper, deliberately kept free of any `db`/`dotenv` import so
// it (and its tests) can be exercised without a DATABASE_URL.
//
// Parses a euro-denominated env var into integer cents. Rejects anything
// that isn't a strictly positive finite number — unset, non-numeric, empty,
// whitespace-only, zero, and negative all throw rather than silently
// producing zero-cent (i.e. free) fees.
export function parseFeeCents(raw: string | undefined, name: string): number {
  const euros = Number(raw);

  if (!Number.isFinite(euros) || euros <= 0) {
    throw new Error(`${name} must be set to a positive number to seed from current prices`);
  }

  return Math.round(euros * 100);
}
