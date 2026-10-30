/**
 * S3 R1/R5 — the legacy reconciliation (docs/superpowers/specs/
 * 2026-10-30-settlement-S3-legacy-plan.md).
 *
 * Santi, 30 Oct — "Reconcile settled lines only": walks the lines marked
 * settled (`refunded = true`) that no settlement operation covers — a pending
 * line is never touched here, it settles through S2 admission — reads the
 * Shopify evidence for its lane and classifies it — paid, unpaid, ambiguous,
 * null-action, needs-human — by explicit identity only
 * (lib/settlement/reconcile.ts). Shopify is only ever READ here. Settled
 * exchanges already recorded as paid are listed again for R2.
 *
 *   dry-run (default)  writes the CSV: every line, its class (the evidence
 *                      status) and why, the evidence found, returned_cents,
 *                      replacement_cents read from Shopify, the approval it
 *                      admits and its cap, and today's fee as a REFERENCE
 *                      only. Nothing computes what is owed.
 *   --write            records `paid` lines as done operations and
 *                      `ambiguous` ones as unresolved operations + alert, in a
 *                      `reconciled` submission per Shopify return and tender
 *                      (lib/settlement/reconcileLedger.ts). Moves no money.
 *                      Re-running skips every line already recorded.
 *   --approve-file <csv>  D1/D2 = A and Santi's "You set each amount": a CSV
 *                      `productsorder_id,amount_cents,approved_by`. Each line
 *                      must admit an approval on THIS run's fresh reads
 *                      (`unpaid`, or a paid exchange whose replacement was
 *                      cheaper), and its amount must be an integer > 0 and
 *                      ≤ its cap (returned, or returned − replacement). Any
 *                      refusal refuses the whole file. With --write, each
 *                      Shopify return's approved lines become one accepted
 *                      legacy submission paying exactly those amounts, with
 *                      one settlement_approvals row each, and are admitted;
 *                      the ledger's recovery cron then sends the payments.
 *                      Without --write it only says what it would record.
 *
 *   --census           cutover coverage (Codex #3): reads EVERY order tagged
 *                      `Change` (all pages, or nothing) and, with --write,
 *                      records each as a replacement by id plus the census
 *                      record (drizzle/0011). Run before the R4 deploy: until
 *                      a census exists the portal refuses to call any order
 *                      ordinary.
 *
 * Every effect a row could have is read whatever its action (Codex #2); a
 * refund that moved money and names no line keeps every line it could have
 * paid ambiguous until scripts/decide-effect.ts binds or excludes it (#1).
 * With --write, an exchange order found paid is recorded as a replacement by
 * id, and its funding only from a complete READ of Stripe's checkout sessions
 * (#5): no paid legacy session for the order → 0; anything else → unfunded
 * (refused online) and an alert. Also writes `<out>.pending-null-action.csv`:
 * the pending NULL-action lines, read-only, for D3 (#8).
 *
 * Refuses to classify anything unless the app holds read_all_orders: without
 * it Shopify answers only the last 60 days of orders, and every "no evidence"
 * would be wrong.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/reconcile-legacy.ts \
 *     --out <file.csv> [--write] [--approve-file <approvals.csv>] [--census] [--by <name>] [--order <orders.id>]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import React from "react";

// db/queries.ts (the catalogue the legacy terms value lines with) wraps
// exports in React's request-scoped cache(), absent outside Next.
const R = React as any;
if (typeof R.cache !== "function") R.cache = (fn: any) => fn;

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const COLUMNS = [
  "productsorder_id",
  "order_id",
  "order_number",
  "return_id",
  "return_status",
  "lane",
  "refunded",
  "class",
  "reason",
  "effect_ref",
  "evidence_amount_cents",
  "evidence_currency",
  "returned_cents",
  "replacement_cents",
  "approval_basis",
  "approval_cap_cents",
  "fee_today_reference_cents",
  "money_effects",
  "unattributed_effects",
  "tender",
  "detail",
] as const;

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      write: { type: "boolean", default: false },
      "approve-file": { type: "string" },
      census: { type: "boolean", default: false },
      by: { type: "string" },
      order: { type: "string" },
    },
  });
  if (!values.out) {
    throw new Error("usage: --out <file.csv> [--write] [--approve-file <csv>] [--by <name>] [--order <id>]");
  }
  const by = values.by ?? userInfo().username;
  const { parseApprovalFile } = await import("@/lib/settlement/reconcile");
  let approvalRows: { productsorderId: number; amountCents: number; approvedBy: string }[] = [];
  if (values["approve-file"]) {
    const parsed = parseApprovalFile(readFileSync(values["approve-file"], "utf8"));
    if (!parsed.ok) throw new Error(`--approve-file: ${parsed.error}. Nothing approved.`);
    approvalRows = parsed.rows;
  }

  const { default: db } = await import("@/db/drizzle");
  const { sql } = await import("drizzle-orm");
  const { orders: ordersTable } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { readFeeTable } = await import("@/db/fees");
  const { getProducts } = await import("@/db/queries");
  const { resolveRootOrderId } = await import("@/lib/replacementOrigin");
  const rec = await import("@/lib/settlement/reconcile");
  const reads = await import("@/lib/settlement/reconcileReads");
  const { legacyTerms, recordedTerms } = await import("@/lib/settlement/legacyTerms");
  const { effectDecisions, recordedEffects } = await import("@/lib/settlement/effectDecisions");
  const { recordReconciliation, reconciliationRecord, reconciliationCoverage } = await import(
    "@/lib/settlement/reconcileLedger"
  );
  const deps = { feeTable: readFeeTable, catalogue: getProducts as any };

  const scopes = await reads.readScopes();
  if (!scopes.ok) throw new Error(`cannot read the app's scopes: ${scopes.error}`);
  if (!scopes.value.includes("read_all_orders")) {
    throw new Error("the app lacks read_all_orders: Shopify would answer only 60 days of orders. Nothing classified.");
  }

  // Cutover coverage (Codex #3): every order tagged `Change`, recorded as a
  // replacement by id, then a census record — all or nothing.
  if (values.census) {
    const census = await import("@/lib/settlement/replacementCensus");
    const found = await census.readChangeOrders();
    if (!found.ok) throw new Error(`census incomplete, nothing recorded: ${found.error}`);
    const identity = census.censusRows(found.value, await census.ourOrderTags());
    const unsourced = identity.filter((r) => !r.source_order_id).length;
    console.error(`census: ${identity.length} Change-tagged orders; ${unsourced} with no single source order of ours.`);
    if (!values.write) {
      console.error("DRY: nothing recorded. Pass --write.");
      return;
    }
    await census.recordCensus(identity, by);
    console.error("census recorded (legacy_replacement_orders + legacy_replacement_census).");
    return;
  }

  // Every confirmed line is read (shared identities span them all); the
  // population is chosen below. gift_card_id is read by name — the
  // schema no longer models it (R4).
  const result: any = await db.execute(sql`
    SELECT p.*, p.gift_card_id AS gift_card_id_raw, o.order_number, o.exchange_of
      FROM productsorder p JOIN orders o ON o.id = p.order_id
     WHERE p.confirmed = true
       ${values.order ? sql`AND p.order_id = ${values.order}` : sql``}
     ORDER BY p.order_id, p.id`);
  const rows: any[] = result?.rows ?? result ?? [];
  const facts = rows.map(
    (r): import("@/lib/settlement/reconcile").LineFacts => ({
      productsorderId: Number(r.id),
      orderId: String(r.order_id),
      orderNumber: String(r.order_number ?? ""),
      returnId: r.return_id ?? null,
      returnLineItemId: r.return_line_item_id ?? null,
      lineItemId: String(r.line_item),
      action: r.action ?? null,
      newVariantId: r.new_variant_id ?? null,
      credit: r.credit === true,
      refunded: r.refunded === true,
      price: String(r.price),
      quantity: Number(r.quantity),
      giftCardId: r.gift_card_id_raw ?? null,
      isReplacement: !!r.exchange_of,
    })
  );
  const decisions = await effectDecisions();
  const shared = rec.sharedIdentity(facts, { recordedEffects: await recordedEffects(), decisions });
  const coverage = await reconciliationCoverage();
  const { rejected, swapCandidates } = coverage;
  const population = rec.reconcilePopulation(facts, coverage);
  console.error(
    `${facts.length} confirmed lines; ${population.length} settled lines to reconcile ` +
      `(${swapCandidates.size} already-recorded exchanges among them, for R2).`
  );

  // Reads, each fetched once.
  const returnReads = new Map<string, Awaited<ReturnType<typeof reads.readReturnEvidence>>>();
  const rootReads = new Map<string, Awaited<ReturnType<typeof reads.readRootRefunds>>>();
  const exchangeReads = new Map<string, Awaited<ReturnType<typeof reads.readExchangeOrders>>>();
  const exchangeOf = new Map(rows.map((r) => [String(r.order_id), r.exchange_of ? String(r.exchange_of) : null]));
  const exchangeOfOf = async (id: string) => {
    if (exchangeOf.has(id)) return exchangeOf.get(id) ?? null;
    const [o] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    const next = (o as any)?.exchangeOf ?? null;
    exchangeOf.set(id, next);
    return next;
  };

  type Out = {
    line: (typeof population)[number];
    c: import("@/lib/settlement/reconcile").Classification;
    customerGid: string | null;
    detail: string[];
  };
  const out: Out[] = [];
  for (const line of population) {
    const r: import("@/lib/settlement/reconcile").LineReads = {
      ret: { ok: false, error: "no return on the line" },
    };
    if (line.returnId) {
      if (!returnReads.has(line.returnId)) returnReads.set(line.returnId, await reads.readReturnEvidence(line.returnId));
      r.ret = returnReads.get(line.returnId)!;
    }
    const need = rec.readsNeeded(line);
    const detail: string[] = [];
    if (need.rootRefunds) {
      try {
        const root = await resolveRootOrderId(line.orderId, exchangeOfOf);
        if (!rootReads.has(root)) rootReads.set(root, await reads.readRootRefunds(root));
        r.rootRefunds = rootReads.get(root)!;
      } catch (e: any) {
        r.rootRefunds = { ok: false, error: `root unresolvable: ${e?.message ?? e}` };
      }
    }
    if (need.giftCard && line.giftCardId) r.giftCard = await reads.readGiftCard(line.giftCardId);
    if (need.exchangeOrders) {
      if (!exchangeReads.has(line.orderNumber)) {
        exchangeReads.set(line.orderNumber, await reads.readExchangeOrders(line.orderNumber));
      }
      r.exchangeOrders = exchangeReads.get(line.orderNumber)!;
    }
    let c = rec.classifyLine(line, r, shared);
    if (rejected.has(line.productsorderId)) c = rec.afterOperatorRejection(c);
    // R5: a settled null-action line is listed with what Shopify shows for it.
    if (c.cls === "null-action") {
      if (!r.exchangeOrders) {
        if (!exchangeReads.has(line.orderNumber)) exchangeReads.set(line.orderNumber, await reads.readExchangeOrders(line.orderNumber));
        r.exchangeOrders = exchangeReads.get(line.orderNumber)!;
      }
      const d = rec.nullActionDiagnostics(line, r.ret, r.exchangeOrders);
      detail.push(`refunds naming the line: ${d.refunds}`, `exchange orders: ${d.exchangeOrders}`, `native exchange lines: ${d.nativeExchangeLines}`);
    }
    if (swapCandidates.has(line.productsorderId)) detail.push("already recorded paid (exchange order); listed for R2");
    const ret = r.ret.ok ? r.ret.value : null;
    out.push({ line, c, customerGid: ret?.order?.customer?.id ?? null, detail });
  }

  // The legacy terms an approval would record, per return and tender.
  const groups = new Map<string, Out[]>();
  for (const o of out) {
    const k = rec.groupKey(o.line);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
  }
  const orderCache = new Map<string, any>();
  const loadOrder = async (id: string) => {
    if (!orderCache.has(id)) {
      const [o] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
      orderCache.set(id, o ?? null);
    }
    return orderCache.get(id);
  };
  const { productsOrder } = await import("@/db/schema");
  const rowsOfOrder = async (id: string) => db.select().from(productsOrder).where(eq(productsOrder.orderId, id));
  type Terms = import("@/lib/settlement/legacyTerms").LegacyTerms;
  const termsFor = async (
    members: Out[]
  ): Promise<{ ok: true; order: any; terms: Terms } | { ok: false; held: string }> => {
    const order = await loadOrder(members[0].line.orderId);
    if (!order) return { ok: false, held: "no-order" };
    const all = await rowsOfOrder(order.id);
    const ids = new Set(members.map((m) => m.line.productsorderId));
    // What a reconciled submission records: no historical figure rebuilt.
    const built = await recordedTerms(all.filter((r) => ids.has(r.id)));
    return built.ok ? { ok: true, order, terms: built.terms } : built;
  };
  const feeTermsFor = async (members: Out[]) => {
    const order = await loadOrder(members[0].line.orderId);
    if (!order) return { ok: false as const, held: "no-order" };
    const all = await rowsOfOrder(order.id);
    const ids = new Set(members.map((m) => m.line.productsorderId));
    return legacyTerms(order, all.filter((r) => ids.has(r.id)), all, deps);
  };

  // Today's fee for the return, a REFERENCE only: the fee in force on the
  // confirmation date is not recoverable, and nothing derives an amount from it.
  const feeReference = new Map<number, { fee: number } | { held: string }>();
  for (const members of Array.from(groups.values())) {
    const t = await feeTermsFor(members);
    for (const m of members) {
      feeReference.set(m.line.productsorderId, t.ok ? { fee: t.terms.agreement.chargedFeeCents } : { held: t.held });
    }
  }

  const csv = [COLUMNS.join(",")];
  for (const { line, c, detail } of out) {
    const ev: any = c.evidence;
    const f = feeReference.get(line.productsorderId);
    const { returnedCents, replacementCents } = rec.lineValues(line, c);
    const basis = rec.approvalBasisOf(line, c);
    if (f && "held" in f) detail.push(`fee reference unavailable: ${f.held}`);
    csv.push(
      [
        line.productsorderId,
        line.orderId,
        line.orderNumber,
        line.returnId,
        c.returnStatus,
        ev?.lane === "native_exchange" ? "native_exchange" : c.lane,
        line.refunded,
        c.cls,
        c.reason,
        ev?.refundId ?? ev?.giftCardId ?? ev?.orderGid ?? ev?.exchangeLineItemId ?? "",
        ev?.amountCents ?? "",
        ev?.currency ?? "",
        returnedCents,
        replacementCents ?? "",
        basis.ok ? basis.basis : "",
        basis.ok ? basis.capCents : "",
        f && "fee" in f ? f.fee : "",
        (c.moneyEffects ?? []).join(" "),
        (c.unattributed ?? []).join(" "),
        line.credit ? "credit" : "refund",
        detail.join("; "),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  writeFileSync(values.out, csv.join("\n") + "\n");
  const counts = out.reduce<Record<string, number>>((m, o) => ((m[o.c.cls] = (m[o.c.cls] ?? 0) + 1), m), {});
  console.error(`CSV: ${values.out} — ${JSON.stringify(counts)}`);

  // #8: the PENDING null-action lines (outside R1: never classified, never
  // written) listed read-only with what Shopify shows, for D3.
  {
    const pending = rec.pendingNullActionLines(facts);
    const listing = [["productsorder_id", "order_id", "order_number", "return_id", "return_status", "refunds_naming_line", "exchange_orders", "native_exchange_lines"].join(",")];
    for (const line of pending) {
      const ret = line.returnId ? await reads.readReturnEvidence(line.returnId) : null;
      const ex = await reads.readExchangeOrders(line.orderNumber);
      const d = rec.nullActionDiagnostics(line, ret, ex);
      listing.push(
        [line.productsorderId, line.orderId, line.orderNumber, line.returnId, d.returnStatus, d.refunds, d.exchangeOrders, d.nativeExchangeLines]
          .map(csvCell)
          .join(",")
      );
    }
    const pendingOut = `${values.out}.pending-null-action.csv`;
    writeFileSync(pendingOut, listing.join("\n") + "\n");
    console.error(`pending NULL-action lines (D3, read-only): ${pendingOut} — ${pending.length}`);
  }

  if (values.write) {
    // Funding for the exchange lines recorded paid, from the real Stripe
    // payments (Codex #5) — read once, completely, or not at all.
    const { legacyFundingOf } = await import("@/lib/settlement/legacyFunding");
    let stripeRead: import("@/lib/settlement/legacyFunding").StripeSessions | null = null;
    const stripeSessions = async () => {
      if (!stripeRead) {
        try {
          const { stripe } = await import("@/lib/stripe");
          const sessions: import("@/lib/settlement/legacyFunding").StripeSession[] = [];
          for await (const s of stripe.checkout.sessions.list({ limit: 100 })) {
            sessions.push({ id: s.id, payment_status: s.payment_status ?? null, metadata: (s.metadata ?? null) as any });
          }
          stripeRead = { ok: true, sessions };
        } catch (e: any) {
          stripeRead = { ok: false, error: String(e?.message ?? e) };
        }
      }
      return stripeRead;
    };
    const orderOfLine = new Map(facts.map((f) => [f.productsorderId, f.orderId]));
    for (const members of Array.from(groups.values())) {
      // An already-recorded exchange is listed for R2 only: never recorded twice.
      const recorded = members.filter(
        (m) => (m.c.cls === "paid" || m.c.cls === "ambiguous") && !swapCandidates.has(m.line.productsorderId)
      );
      if (recorded.length === 0) continue;
      const t = await termsFor(recorded);
      const label = `${members[0].line.orderNumber} ${members[0].line.returnId}`;
      if (!t.ok) {
        console.error(`NOT recorded ${label}: ${t.held}`);
        continue;
      }
      const funding = new Map<number, import("@/lib/settlement/reconcileLedger").LineFunding>();
      for (const m of recorded) {
        if (m.c.cls === "paid" && m.c.evidence?.lane === "exchange") {
          funding.set(
            m.line.productsorderId,
            legacyFundingOf(m.line.orderId, await stripeSessions(), decisions, (po) => orderOfLine.get(po) ?? null)
          );
        }
      }
      const record = reconciliationRecord(
        t.terms,
        recorded.map((m) => ({ line: m.line, classification: m.c, customerGid: m.customerGid })),
        by,
        undefined,
        funding
      );
      const done = await recordReconciliation(t.order, t.terms, record);
      console.error(
        `${done.recorded ? "recorded" : "already recorded / refused"} ${label}: ` +
          `${record.ops.filter((o) => o.state === "done").length} done, ` +
          `${record.ops.filter((o) => o.state === "unresolved").length} unresolved; settled ${done.settled.join(",") || "-"}`
      );
    }
  }

  if (approvalRows.length > 0) {
    const { approvalProblem, recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const byId = new Map(out.map((o) => [o.line.productsorderId, o]));
    type Approval = import("@/lib/settlement/legacy").ApprovalInput;
    const approvals: Approval[] = [];
    const refused: string[] = [];
    for (const a of approvalRows) {
      const o = byId.get(a.productsorderId);
      if (!o) {
        refused.push(`${a.productsorderId}: not in this run's population`);
        continue;
      }
      const basis = rec.approvalBasisOf(o.line, o.c);
      if (!basis.ok) {
        refused.push(`${a.productsorderId}: ${basis.reason}`);
        continue;
      }
      const approval: Approval = { ...a, basis: basis.basis, capCents: basis.capCents };
      const problem = approvalProblem(approval);
      if (problem) refused.push(`${a.productsorderId}: ${problem}`);
      else approvals.push(approval);
    }
    if (refused.length > 0) throw new Error(`--approve-file refused, nothing approved:\n  ${refused.join("\n  ")}`);

    const byGroup = new Map<string, Approval[]>();
    for (const a of approvals) {
      const k = rec.groupKey(byId.get(a.productsorderId)!.line);
      (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(a);
    }
    const { admit } = await import("@/lib/settlement/admission");
    for (const group of Array.from(byGroup.values())) {
      const ids = group.map((a) => a.productsorderId);
      const label = group.map((a) => `${a.productsorderId}=${a.amountCents} (${a.basis}, by ${a.approvedBy})`).join(", ");
      if (!values.write) {
        console.error(`DRY: would record and admit ${label}`);
        continue;
      }
      const sub = await recordApprovedLegacySubmission(group);
      if (!sub.ok) {
        console.error(`approved ${label} NOT recorded: ${sub.held}`);
        continue;
      }
      const admitted = await admit(sub.submissionId, ids);
      console.error(
        `approved ${label}: submission ${sub.submissionId}, ` +
          (admitted.ok ? `admitted ${admitted.admitted.join(",")} — recovery sends it` : `held: ${admitted.held}`)
      );
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
