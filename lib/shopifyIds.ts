/**
 * Canonicalising Shopify global ids.
 *
 * Pure — no network, no database, no env. Safe to import from client
 * components.
 *
 * `productsorder` stores its two variant columns in different shapes, and
 * nothing enforces either:
 *
 *   variant_id      55904239812934                                (bare)
 *   new_variant_id  gid://shopify/ProductVariant/55904239845702   (GID)
 *
 * Every builder that wrapped `new_variant_id` in a prefix therefore emitted a
 * double-prefixed id, which Shopify rejects outright — taking the whole
 * mutation with it:
 *
 *   Invalid global id
 *   'gid://shopify/ProductVariant/gid://shopify/ProductVariant/55904239845702'
 *
 * That is why not one of the 259 exchange lines in the table had ever had a
 * stock hold placed against it (order #310741, 2026-08-13). `db/queries.ts`
 * had already grown its own private strip-then-re-add against the same
 * problem; this is that idea made shared and idempotent, so it stops mattering
 * which shape a given column holds.
 */

const VARIANT_PREFIX = "gid://shopify/ProductVariant/";

/**
 * A variant id as a Shopify global id, from either shape — or null when the
 * input cannot be resolved to one.
 *
 * Null rather than a best-effort string on purpose. These ids go into
 * list-valued mutation inputs where Shopify validates every element and
 * rejects the ENTIRE call on one bad entry, so a caller that cannot build a
 * valid id must drop that line rather than poison its siblings. Callers filter
 * on null; see `buildReservationDraft` and `buildReturnInput`.
 */
export function variantGid(
  id: string | number | null | undefined
): string | null {
  const raw = String(id ?? "").trim();
  if (!raw) return null;

  // Strip any number of prefixes, so a value that has already been wrapped
  // once — or twice, as in #310741 — normalises to the same id.
  const numeric = raw.replace(
    new RegExp(`^(?:${VARIANT_PREFIX.replace(/\//g, "\\/")})+`),
    ""
  );

  // Only digits. A ProductVariant gid that arrives as some other resource
  // ("gid://shopify/Product/123") keeps its slashes here and is refused, which
  // is what we want: silently reshaping it would send Shopify a confident,
  // wrong id.
  if (!/^\d+$/.test(numeric)) return null;

  return `${VARIANT_PREFIX}${numeric}`;
}
