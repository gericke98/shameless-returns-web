// L3 — admission: read the agreement and the Shopify facts, plan every effect
// the admitted lines require, and write them in ONE statement
// (lib/settlement/ledger.ts `insertAdmission`).
//
// Admission is the only step the auto-approve gate, its cap and
// AUTO_APPROVE_ENABLED govern; running admitted operations (lib/settlement/
// run.ts) is not gated.
//
// NOT "use server".
import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders, productsOrder } from "@/db/schema";
import { rootOrderIdOf } from "@/actions/replacementOrder";
import { readDraftExists, readPayingOrder, readReturnFacts } from "./facts";
import { insertAdmission, loadSubmission, operationsOf } from "./ledger";
import { planAdmission, type PayingOrder, type ReturnFacts } from "./plan";

export type AdmitOutcome =
  | { ok: true; admitted: number[] }
  | { ok: false; held: string };

/** 16 characters from an unambiguous alphabet: the gift card's code, frozen at admission. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newGiftCardCode(): string {
  const bytes = randomBytes(16);
  let code = "";
  for (const b of Array.from(bytes)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** The whole exchange travels as one parcel: admitting one CAMBIO line admits all. */
export function expandAdmission(
  lines: ReadonlyArray<{ productsorderId: number; action: string }>,
  requested: readonly number[]
): number[] {
  const set = new Set(requested);
  const byId = new Map(lines.map((l) => [l.productsorderId, l]));
  if (requested.some((id) => byId.get(id)?.action === "CAMBIO")) {
    for (const line of lines) if (line.action === "CAMBIO") set.add(line.productsorderId);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export async function admit(submissionId: string, requested: readonly number[]): Promise<AdmitOutcome> {
  // One retry on a lost admission_seq race; a cancellation is final.
  for (let round = 0; round < 2; round += 1) {
    const loaded = await loadSubmission(submissionId);
    if (!loaded) return { ok: false, held: "no-submission" };
    const { submission, lines } = loaded;
    if (submission.state !== "accepted") return { ok: false, held: `not-accepted:${submission.state}` };
    if (submission.holder === "cancellation") return { ok: false, held: "cancelling" };

    const admitIds = expandAdmission(lines, requested);
    const existing = await operationsOf(submissionId);

    const [order] = await db.select().from(orders).where(eq(orders.id, submission.orderId));
    if (!order) return { ok: false, held: "no-order" };
    const rowList = admitIds.length
      ? await db.select().from(productsOrder).where(inArray(productsOrder.id, lines.map((l) => l.productsorderId)))
      : [];
    const rows = new Map(
      rowList.map((r) => [r.id, { returnId: r.return_id ?? null, transactionId: r.transaction_id ?? null }])
    );

    const returns = new Map<string, ReturnFacts>();
    for (const returnId of Array.from(new Set(admitIds.map((id) => rows.get(id)?.returnId).filter(Boolean))) as string[]) {
      const facts = await readReturnFacts(returnId);
      if (!facts.ok) return { ok: false, held: `shopify-unreadable:${returnId}` };
      if (facts.value) returns.set(returnId, facts.value);
    }

    // The payment a refund outside a returnProcess goes against: the root's
    // largest settled payment for a replacement order (as refundSourceFor
    // resolves it), the rows' stored parent for an ordinary one.
    let paying: PayingOrder | null = null;
    const isReplacement = !!order.exchangeOf;
    const needsPaying =
      submission.tender === "refund" && (isReplacement || submission.residualCents > 0);
    if (needsPaying) {
      let payingOrderId = order.id;
      let parent: string | null = null;
      if (isReplacement) {
        try {
          payingOrderId = await rootOrderIdOf(order.id);
        } catch {
          return { ok: false, held: "root-unresolvable" };
        }
      } else {
        const parents = new Set(
          lines.map((l) => rows.get(l.productsorderId)?.transactionId).filter(Boolean) as string[]
        );
        if (parents.size !== 1) return { ok: false, held: `refund-parents:${parents.size}` };
        parent = Array.from(parents)[0];
      }
      const read = await readPayingOrder(payingOrderId, parent);
      if (!read.ok) return { ok: false, held: `shopify-unreadable:order-${payingOrderId}` };
      paying = read.value;
    }

    let reservation: { draftOrderId: string; existed: boolean } | null = null;
    const exchanging = admitIds.some((id) => lines.find((l) => l.productsorderId === id)?.action === "CAMBIO");
    if (exchanging && order.exchangeReservationId) {
      const exists = await readDraftExists(order.exchangeReservationId);
      if (!exists.ok) return { ok: false, held: "shopify-unreadable:reservation" };
      reservation = { draftOrderId: order.exchangeReservationId, existed: exists.value };
    }

    const plan = planAdmission({
      submission,
      lines,
      admit: admitIds,
      existing: existing.map((o) => ({ id: o.id, kind: o.kind, scopeKey: o.scopeKey })),
      rows,
      returns,
      isReplacement,
      paying,
      reservation,
      order: order as any,
      newId: randomUUID,
      newGiftCardCode,
    });
    if (!plan.ok) return { ok: false, held: plan.held };

    const written = await insertAdmission({
      submissionId,
      seenSeq: submission.admissionSeq,
      ops: plan.ops,
      reverseFulfillment: plan.reverseFulfillment,
    });
    if (written.admitted) return { ok: true, admitted: admitIds };
  }
  const after = await loadSubmission(submissionId);
  if (after?.submission.holder === "cancellation") return { ok: false, held: "cancelling" };
  return { ok: false, held: "admission-contended" };
}
