// Pure — no db, no env, no network. Works out which Amphora return is the one
// for each of our orders, so the crons and the ops scripts cannot drift on the
// answer.
//
// Every link used here is a field Amphora sends, never inferred from shape:
//   · `order_id` — Amphora's order reference, `SHP <shopify order id>` for a
//     Shopify order. It is the ORDER link. The return's own `id` is not: since
//     ~2026-08-26, returns we create through the API get ids like `RET <n>`.
//   · `external_id` — set only by our POST /returns, to our order id. It is the
//     statement "we created this record".
//
// An order can legitimately have more than one Amphora record: every return we
// book now comes with a `SHP <order id>` shadow from Amphora's Shopify channel,
// `external_id: null`, stuck at PENDING. So per order:
//   · exactly one record of ours  → that one; shadows are ignored.
//   · two or more of ours         → refused and reported.
//   · none of ours, one record    → that one (Amphora re-created our return in
//                                   their UI, the 2026-08-05 case).
//   · none of ours, several       → refused and reported.
// An `external_id` that disagrees with the record's `order_id` is refused and
// reported. Nothing here breaks a tie on carrier, time or position.
//
// Deciding ownership is NOT this module's job: a match only says which record
// an order id refers to. The caller still checks the order is ours (and, for
// the status sync, international) — Amphora's Shopify-channel returns match too.
import { orderIdFromWebhook } from "@/lib/amphoraWebhook";

export type MatchableReturn = {
  id?: string | null;
  /** Amphora's order reference, e.g. `SHP 13192219558214`. */
  order_id?: string | null;
  external_id?: string | null;
};

export type ReturnMatch<T> = {
  /** Amphora's id for the matched return (`SHP …`, `RET …`). */
  amphoraReturnId: string;
  orderId: string;
  ret: T;
  /** True when we created it. The caller relaxes its checks for these. */
  viaExternalId: boolean;
};

export type MatchConflict = {
  kind: "external-id-mismatch" | "ambiguous-order";
  /** The Amphora id the conflict is about: the return id for a mismatch, the
   *  Amphora order id for an ambiguous order. Used as the alert's identity. */
  amphoraId: string;
  /** The order an `ambiguous-order` conflict is about; null for a mismatch. */
  orderId: string | null;
  /** True when a record involved carries our `external_id`: proof the
   *  conflict is ours to report. When false (Amphora's own records), the
   *  caller reports it only if the order is one it manages. */
  createdByUs: boolean;
  detail: string;
};

export type MatchResult<T> = {
  matches: ReturnMatch<T>[];
  conflicts: MatchConflict[];
};

/** Our Shopify order id from Amphora's `order_id`, or null if it names none. */
function orderIdOf(ret: MatchableReturn): string | null {
  return orderIdFromWebhook({ id: ret.order_id ?? null });
}

const describe = (r: MatchableReturn) =>
  `${r.id?.trim() || "(no id)"} [external_id ${r.external_id?.trim() || "null"}]`;

export function matchReturnsToOrderIds<T extends MatchableReturn>(
  returns: T[]
): MatchResult<T> {
  const byOrderId = new Map<string, T[]>();
  const conflicts: MatchConflict[] = [];

  for (const ret of returns) {
    const orderId = orderIdOf(ret);
    const external = ret.external_id?.trim() || null;

    if (!orderId || (external && external !== orderId)) {
      // A record nobody claims and that names no Shopify order is Amphora's
      // business (manual orders, `MNL …`). One WE created that we cannot place
      // is ours to look at.
      if (external) {
        conflicts.push({
          kind: "external-id-mismatch",
          amphoraId: ret.id?.trim() || `(no id, external_id ${external})`,
          orderId: null,
          createdByUs: true,
          detail: `external_id ${external} disagrees with order_id ${ret.order_id ?? "(none)"}`,
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
    const ours = group.filter((r) => r.external_id?.trim() === orderId);
    const chosen = ours.length === 1 ? ours[0] : ours.length === 0 && group.length === 1 ? group[0] : null;

    if (!chosen || !chosen.id?.trim()) {
      conflicts.push({
        kind: "ambiguous-order",
        amphoraId: `SHP ${orderId}`,
        orderId,
        createdByUs: ours.length > 0,
        detail:
          ours.length > 1
            ? `${ours.length} records we created for one order: ${ours.map(describe).join(", ")}`
            : !chosen
              ? `${group.length} records for one order, none created by us: ${group.map(describe).join(", ")}`
              : `the record for this order has no id`,
      });
      continue;
    }

    matches.push({
      amphoraReturnId: chosen.id.trim(),
      orderId,
      ret: chosen,
      viaExternalId: ours.length === 1,
    });
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

/** The ops alert for one conflict. The dedupe key is the Amphora id, so a
 *  conflict that persists across runs is reported once, not every 15 min. */
export function matchConflictAlert(conflict: MatchConflict): {
  dedupeKey: string;
  subject: string;
  body: string;
} {
  return {
    dedupeKey: `match-conflict:${conflict.amphoraId}`,
    subject: `[returns] AMPHORA RETURN NOT MATCHED — ${conflict.amphoraId}`,
    body: [
      `Amphora ${conflict.amphoraId} could not be tied to exactly one return for one order (${conflict.kind}):`,
      `${conflict.detail}.`,
      ``,
      `Until this is fixed, neither the status sync, auto-approve nor the short-receipt`,
      `check will act on this order: no customer notification, no settlement. Check the`,
      `records in the Amphora UI and ask Amphora to correct them.`,
    ].join("\n"),
  };
}
