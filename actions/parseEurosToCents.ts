// Pure parsing helper, deliberately kept in its own module (no "use server",
// no db import) so it — and its tests — can be exercised without a
// DATABASE_URL and without pulling in the server-action transform that
// actions/shippingFees.ts is subject to (every top-level export of a
// "use server" file must be an async server action).
//
// "12", "12.5", "12.50" -> cents. Rejects negatives, NaN and >2 decimals.
// Unlike scripts/parseFeeCents.ts (which seeds initial prices and refuses
// zero, since seeding zero would make every return free by accident), this
// helper backs the admin editor and must allow zero: a genuinely free
// return lane for some country is a legitimate business choice, not a
// misconfiguration.
export function parseEurosToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const euros = Number(trimmed);
  if (!Number.isFinite(euros) || euros < 0) return null;
  return Math.round(euros * 100);
}
