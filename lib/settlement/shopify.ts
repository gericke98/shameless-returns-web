// The one Shopify Admin GraphQL transport the settlement ledger uses.
//
// NOT "use server": nothing here may be a browser-callable endpoint. Reads
// (admission facts, evidence) and the ledger's mutations (lib/settlement/
// effects.ts, the only file holding mutation documents) both go through it,
// all on one pinned API version.
//
// The transport reports two outcomes and never more: Shopify ANSWERED (we have
// a parsed body — which may still carry userErrors or top-level errors, for
// the caller to judge), or there was NO ANSWER (network error, timeout,
// non-2xx, unparseable body). A no-answer says nothing about whether the
// effect happened; the ledger treats it as "stays dispatched".

/** Every settlement call is made against this version (see the S2 plan). */
export const SHOPIFY_API_VERSION = "2026-04";

/** A request that has not answered in this long is a no-answer. */
const TIMEOUT_MS = 30_000;

export type ShopifyAnswer =
  | { kind: "answer"; body: any }
  | { kind: "no-answer"; error: string };

export async function shopifyGraphQL(
  query: string,
  variables: Record<string, unknown>
): Promise<ShopifyAnswer> {
  const shop = process.env.NEXT_PUBLIC_SHOP_URL;
  const token = process.env.NEXT_PUBLIC_ACCESS_TOKEN;
  if (!shop || !token) return { kind: "no-answer", error: "missing Shopify credentials" };
  try {
    const response = await fetch(`${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { kind: "no-answer", error: `HTTP ${response.status}` };
    const body = await response.json();
    return { kind: "answer", body };
  } catch (error: any) {
    return { kind: "no-answer", error: String(error?.message ?? error) };
  }
}

/** Top-level GraphQL errors: Shopify answered but gave no verdict. */
export function graphQLErrors(body: any): string | null {
  return Array.isArray(body?.errors) && body.errors.length > 0
    ? JSON.stringify(body.errors).slice(0, 2000)
    : null;
}
