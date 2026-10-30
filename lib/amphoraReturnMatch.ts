// Pure — no db, no env, no network. Works out which of our orders each Amphora
// return belongs to, so the cron and the ops scripts cannot drift on the answer.
//
// The ONE key is Amphora's return id, `SHP <shopify order id>`. It is their
// primary key: the Company API addresses every return operation by it
// (`/returns/{return_id}/approve|travelling|received|cancel|shipping_label`),
// and it is present on every record, including the ones Amphora creates in
// their own UI (all seven stranded returns on 2026-08-05 carried
// `external_id: null` and matched by id alone).
//
// `external_id` (our Shopify order id, set by POST /returns) is NOT a second
// key. It is a statement that we created the record, kept as data for callers
// (`viaExternalId`), and it must agree with the id. When it does not, or when
// one listing holds two records under one id, nothing here chooses between
// them: the order is refused and the conflict reported, so a human looks. The
// tie-breakers that used to live here (carrier presence, creation time,
// first-seen) resolved a state the source of truth does not produce, and
// guessed when it did.
//
// Deciding ownership is NOT this module's job: an id match only says which
// order a return refers to. The caller still has to check the order is ours and
// international — Amphora's Shopify-channel returns match by id too.
import { orderIdFromWebhook } from "@/lib/amphoraWebhook";

export type MatchableReturn = {
  id?: string | null;
  external_id?: string | null;
};

export type ReturnMatch<T> = {
  /** Amphora's key for this return, `SHP <orderId>`. */
  amphoraReturnId: string;
  orderId: string;
  ret: T;
  /** True when we created it. The caller relaxes its checks for these. */
  viaExternalId: boolean;
};

export type MatchConflict = {
  kind: "external-id-mismatch" | "duplicate-id";
  /** The Amphora return id the conflict is about, as Amphora sent it. */
  amphoraReturnId: string;
  detail: string;
};

export type MatchResult<T> = {
  matches: ReturnMatch<T>[];
  conflicts: MatchConflict[];
};

/**
 * One match per Amphora return id, or none and a conflict.
 *
 * - The order id is the one inside `id`. A record whose `id` names no order is
 *   dropped, unless it carries an `external_id` — then we created it and cannot
 *   place it, which is reported.
 * - `external_id`, when present, must equal that order id; otherwise the record
 *   is skipped and reported.
 * - Two records under the same id: the order is skipped entirely and reported.
 */
export function matchReturnsToOrderIds<T extends MatchableReturn>(
  returns: T[]
): MatchResult<T> {
  const byOrderId = new Map<string, T[]>();
  const conflicts: MatchConflict[] = [];

  for (const ret of returns) {
    const orderId = orderIdFromWebhook(ret);
    const external = ret.external_id?.trim() || null;

    if (!orderId) {
      if (external) {
        conflicts.push({
          kind: "external-id-mismatch",
          amphoraReturnId: ret.id?.trim() || `(no id, external_id ${external})`,
          detail: `external_id ${external} on a return whose id names no order`,
        });
      }
      continue;
    }

    const group = byOrderId.get(orderId);
    if (group) group.push(ret);
    else byOrderId.set(orderId, [ret]);
  }

  const matches: ReturnMatch<T>[] = [];
  // Array.from, not a spread: this tsconfig sets no `target`, so tsc defaults to
  // ES5 and refuses to iterate a Map iterator. `next build` catches it; vitest
  // does not — which is how this reached main and failed two prod deploys.
  for (const [orderId, group] of Array.from(byOrderId.entries())) {
    const amphoraReturnId = `SHP ${orderId}`;

    if (group.length > 1) {
      conflicts.push({
        kind: "duplicate-id",
        amphoraReturnId,
        detail: `${group.length} records under one return id (external_id: ${group
          .map((r) => r.external_id?.trim() || "null")
          .join(", ")})`,
      });
      continue;
    }

    const ret = group[0];
    const external = ret.external_id?.trim() || null;
    if (external && external !== orderId) {
      conflicts.push({
        kind: "external-id-mismatch",
        amphoraReturnId,
        detail: `external_id ${external} does not match the order id ${orderId} in the return id`,
      });
      continue;
    }

    matches.push({ amphoraReturnId, orderId, ret, viaExternalId: Boolean(external) });
  }

  return { matches, conflicts };
}

/**
 * The ops alert for a return WE created (it carries our `external_id`) whose
 * order we do not hold. An Amphora-created record with no order is normal (their
 * Shopify-channel returns) and is not reported.
 */
export function unknownOrderAlert(amphoraReturnId: string, name?: string | null): {
  dedupeKey: string;
  subject: string;
  body: string;
} {
  return {
    dedupeKey: `match-no-order:${amphoraReturnId}`,
    subject: `[returns] AMPHORA RETURN WITH NO ORDER — ${amphoraReturnId}`,
    body: [
      `Amphora return ${amphoraReturnId}${name ? ` (${name})` : ""} carries our external_id,`,
      `so we booked it, but no order with that id is in our database.`,
      ``,
      `Nothing is synced for it: no customer notification. Find the order in Shopify and`,
      `check why its row is missing before the customer chases it.`,
    ].join("\n"),
  };
}

/** The ops alert for one conflict. The dedupe key is the Amphora return id, so
 *  a conflict that persists across runs is reported once, not every 15 min. */
export function matchConflictAlert(conflict: MatchConflict): {
  dedupeKey: string;
  subject: string;
  body: string;
} {
  return {
    dedupeKey: `match-conflict:${conflict.amphoraReturnId}`,
    subject: `[returns] AMPHORA RETURN NOT MATCHED — ${conflict.amphoraReturnId}`,
    body: [
      `Amphora return ${conflict.amphoraReturnId} could not be tied to one order (${conflict.kind}):`,
      `${conflict.detail}.`,
      ``,
      `Until this is fixed, neither the status sync nor auto-approve will act on`,
      `this order: no customer notification, no settlement. Check the record in the`,
      `Amphora UI and ask Amphora to correct it.`,
    ].join("\n"),
  };
}
