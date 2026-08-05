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

/**
 * One match per order, so a re-created return and the record it replaced can
 * never both be applied in the same sweep.
 *
 * A return we created wins outright — its `external_id` is a direct statement of
 * ownership, where a recovered id is an inference. Between two inferred ones,
 * the newest wins, because that is the one Amphora is actually working.
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
    if (held.viaExternalId) continue;
    if (candidate.viaExternalId || createdAt(ret) > createdAt(held.ret)) {
      best.set(orderId, candidate);
    }
  }

  return [...best.values()];
}
