// Pure — no db, no env, no network. Works out which of our orders each Amphora
// return belongs to, so the cron and the ops scripts cannot drift on the answer.
//
// Two links exist, and we need both:
//   · `external_id` — our Shopify order id, set by POST /returns. Present only
//     on returns WE created.
//   · the `SHP <shopify order id>` return id — present on every return,
//     including the ones Amphora creates in their own UI, which is what they
//     did to all seven stranded returns on 2026-08-05. Those carry
//     `external_id: null` and were invisible to the sync until this existed.
//
// Deciding ownership is NOT this module's job: an id match only says which
// order a return refers to. The caller still has to check the order is ours and
// international — Amphora's Shopify-channel returns match by id too.
import { orderIdFromWebhook } from "@/lib/amphoraWebhook";

export type MatchableReturn = {
  id?: string | null;
  name?: string | null;
  external_id?: string | null;
  time?: string | null;
  /** Read only to break the tie below — a carrier is proof Amphora is actually
   *  working that record. */
  carrier?: string | null;
};

export type ReturnMatch<T> = {
  orderId: string;
  ret: T;
  /** True when we created it. The caller relaxes its checks for these. */
  viaExternalId: boolean;
};

/** Sortable creation time. A missing stamp sorts oldest so a dated return
 *  always beats an undated one. */
function createdAt(ret: MatchableReturn): number {
  const stamp = ret.time;
  if (!stamp) return -Infinity;
  // Amphora sends both bare local stamps and offset-aware ones; read a bare one
  // as UTC so this behaves the same on a laptop and in a Vercel function.
  const iso = /[Z+]|-\d{2}:\d{2}$/.test(stamp) ? stamp : `${stamp}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Has Amphora put a courier on this record? */
function hasCarrier(ret: MatchableReturn): boolean {
  return Boolean(ret.carrier?.trim());
}

/**
 * One match per order, so a re-created return and the record it replaced can
 * never both be applied in the same sweep.
 *
 * A return we created normally wins — its `external_id` is a direct statement of
 * ownership, where a recovered id is an inference. Between two inferred ones,
 * the newest wins, because that is the one Amphora is actually working.
 *
 * The ONE exception: our record has no carrier and a same-order orphan does. On
 * 2026-08-05 Amphora fixed the seven stranded returns by DELETING ours and
 * re-creating theirs, so precedence never came up. If they re-create without
 * deleting, an unconditional `external_id` win hands the sweep our dead
 * carrier-less record, `applyReturnStatus` sees an unchanged status, no-ops, and
 * the customer is never told a courier was assigned — the original ten-day
 * incident, reproduced by the fix meant to prevent it. A carrier is the one
 * signal that says which of the two records Amphora is really working.
 */
export function matchReturnsToOrderIds<T extends MatchableReturn>(
  returns: T[]
): ReturnMatch<T>[] {
  const best = new Map<string, ReturnMatch<T>>();

  for (const ret of returns) {
    const external = ret.external_id?.trim();
    const orderId = external || orderIdFromWebhook(ret);
    if (!orderId) continue;

    const candidate: ReturnMatch<T> = {
      orderId,
      ret,
      viaExternalId: Boolean(external),
    };
    const held = best.get(orderId);

    if (!held) {
      best.set(orderId, candidate);
      continue;
    }
    // Two of ours: first seen wins, as before.
    if (held.viaExternalId && candidate.viaExternalId) continue;

    if (held.viaExternalId) {
      // Held is ours, candidate is an orphan. Ours wins unless it is the dead
      // carrier-less record and the orphan is the one carrying a courier.
      if (!hasCarrier(held.ret) && hasCarrier(ret)) best.set(orderId, candidate);
      continue;
    }

    if (candidate.viaExternalId) {
      // Same rule, reached from the other direction: keep the orphan only when
      // it has a carrier and ours does not.
      if (hasCarrier(ret) || !hasCarrier(held.ret)) best.set(orderId, candidate);
      continue;
    }

    // Two orphans: newest wins — that is the one Amphora is working.
    if (createdAt(ret) > createdAt(held.ret)) best.set(orderId, candidate);
  }

  return [...best.values()];
}
