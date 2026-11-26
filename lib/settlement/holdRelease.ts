// FX §#8 — the one-off MIGRATION that releases the stock-hold drafts placed
// before FX. Nothing places one any more; this is the only authority left to
// delete one (`releaseHoldDraft` in lib/settlement/effects.ts, the ONE
// draftOrderDelete document, on SHOPIFY_API_VERSION).
//
// Input is explicit, persisted data: the order's pointer
// `orders.exchange_reservation_id` (draft id + owning order). A draft is never
// found by tag or name. Per draft, Shopify is READ first:
//   unreadable    — the read failed: nothing done, re-run later;
//   already-gone  — no such draft: the pointer is cleared;
//   completed     — status COMPLETED, or it became an order: NEVER deleted;
//                   the pointer stays (Santi decides it by hand before P4);
//   otherwise it is deleted, then read BACK:
//   deleted       — gone: the pointer is cleared;
//   still-exists  — present: the pointer stays.
// Each outcome is one append-only `hold_draft_releases` row, written in the
// SAME statement as the conditional pointer clear (`WHERE id = order AND
// exchange_reservation_id = draft`: a pointer that changed meanwhile is
// reported, never overwritten). Re-running is idempotent: a crash after a
// delete reads `already-gone` next time.
//
// NOT "use server". Run by scripts/release-hold-drafts.ts (dry-run default).
import { sql } from "drizzle-orm";
import { readQuery, writeDb } from "@/db/drizzle";
import type { SystemTarget } from "@/lib/server/identity";
import { releaseHoldDraft, type HoldReleaseAuthority } from "./effects";
import { HOLD_DRAFT_QUERY, read } from "./reads";

const rowsOf = (result: any): any[] => result?.rows ?? result ?? [];

export type DraftOutcome = "unreadable" | "already-gone" | "completed" | "deleted" | "still-exists";

export type DraftRelease = {
  orderId: string;
  draftOrderId: string;
  /** Dry run: what Shopify shows now (`would-delete` for an open draft). */
  outcome: DraftOutcome | "would-delete";
  detail: Record<string, unknown>;
  pointerCleared: boolean;
};

type DraftNow = { ok: false; error: string } | { ok: true; draft: { id: string; status: string; order: { id: string } | null } | null };

async function draftNow(draftOrderId: string): Promise<DraftNow> {
  const r = await read(HOLD_DRAFT_QUERY, { id: draftOrderId }, (d) => d?.draftOrder ?? null);
  return r.ok ? { ok: true, draft: r.value } : { ok: false, error: r.error };
}

async function record(cap: SystemTarget, by: string, r: Omit<DraftRelease, "pointerCleared">): Promise<boolean> {
  const clears = r.outcome === "deleted" || r.outcome === "already-gone";
  const [row] = rowsOf(
    await writeDb(cap).execute(sql`
      WITH u AS (
        UPDATE orders SET exchange_reservation_id = NULL
         WHERE ${clears}::boolean AND id = ${r.orderId} AND exchange_reservation_id = ${r.draftOrderId}
        RETURNING 1
      ),
      ins AS (
        INSERT INTO hold_draft_releases (id, order_id, draft_order_id, outcome, detail, released_by, pointer_cleared)
        SELECT gen_random_uuid(), ${r.orderId}, ${r.draftOrderId}, ${r.outcome}, ${JSON.stringify(r.detail)}::jsonb, ${by},
               EXISTS (SELECT 1 FROM u)
        RETURNING pointer_cleared
      )
      SELECT (SELECT pointer_cleared FROM ins) AS cleared
    `)
  );
  return row?.cleared === true;
}

export async function releaseHoldDraftsForMigration(
  cap: SystemTarget,
  options: { write: boolean; by: string }
): Promise<{ releases: DraftRelease[]; remainingPointers: number }> {
  if (!options.by.trim()) throw new Error("releaseHoldDraftsForMigration: who (--by) is required");
  const pointers = rowsOf(
    await readQuery(sql`
      SELECT id, exchange_reservation_id FROM orders WHERE exchange_reservation_id IS NOT NULL ORDER BY id
    `)
  );

  const releases: DraftRelease[] = [];
  for (const p of pointers) {
    const orderId = String(p.id);
    const draftOrderId = String(p.exchange_reservation_id);
    const before = await draftNow(draftOrderId);
    let outcome: DraftRelease["outcome"];
    const detail: Record<string, unknown> = {};
    if (!before.ok) {
      outcome = "unreadable";
      detail.error = before.error;
    } else if (!before.draft) {
      outcome = "already-gone";
    } else if (before.draft.status === "COMPLETED" || before.draft.order) {
      outcome = "completed";
      detail.status = before.draft.status;
      detail.order = before.draft.order?.id ?? null;
    } else if (!options.write) {
      outcome = "would-delete";
      detail.status = before.draft.status;
    } else {
      const authority = { orderId, draftOrderId, by: "migration" } as HoldReleaseAuthority;
      const answer = await releaseHoldDraft(authority);
      detail.answer = answer.kind === "answer" ? answer.body?.data?.draftOrderDelete ?? answer.body : answer;
      // Whatever Shopify answered, its state decides.
      const after = await draftNow(draftOrderId);
      if (!after.ok) {
        outcome = "unreadable";
        detail.error = after.error;
      } else {
        outcome = after.draft ? "still-exists" : "deleted";
      }
    }
    const pointerCleared =
      options.write && outcome !== "would-delete"
        ? await record(cap, options.by, { orderId, draftOrderId, outcome, detail })
        : false;
    releases.push({ orderId, draftOrderId, outcome, detail, pointerCleared });
  }

  const [left] = rowsOf(
    await readQuery(sql`SELECT count(*)::int AS n FROM orders WHERE exchange_reservation_id IS NOT NULL`)
  );
  return { releases, remainingPointers: Number(left?.n ?? 0) };
}
