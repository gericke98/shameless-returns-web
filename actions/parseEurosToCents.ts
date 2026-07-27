// Pure parsing helper, deliberately kept in its own module (no "use server",
// no db import) so it — and its tests — can be exercised without a
// DATABASE_URL and without pulling in the server-action transform that
// actions/shippingFees.ts is subject to (every top-level export of a
// "use server" file must be an async server action).
//
// "12", "12.5", "12.50" -> cents. Also accepts a comma decimal separator
// ("12,50"), a deliberate concession to European number-format input, since
// this form is user-facing. That same one-comma-only rule is what makes a
// thousands-separated value like "1,500" get rejected rather than silently
// parsed as 1.5 — the comma is swapped for a dot and then the result must
// still match "at most two digits after one separator", so a thousands
// grouping fails the regex instead of being misread.
// Rejects negatives, NaN and >2 decimals.
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
