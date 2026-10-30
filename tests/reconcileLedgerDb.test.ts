import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settlementDatabase } from "./support/settlementDb";

// S3 R1 `--write`, D1/D2 approval and D3 on PGlite with the real migrations
// (0004, 0006–0009): paid → done operation + refunded, idempotent; ambiguous →
// unresolved + alert; unpaid → nothing; a reconciliation record is never
// claimable, holds admission and the legacy recorder, and an operator's
// "no payment" releases the line to an approved payment. Shopify is mocked at
// the transport.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
const env = settlementDatabase();
vi.mock("@/db/drizzle", () => ({ default: env.db, transact: (s: any) => env.transact(s) }));
const answers: Record<string, (variables: any) => any> = {};
vi.mock("@/lib/settlement/shopify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settlement/shopify")>();
  return {
    ...actual,
    shopifyGraphQL: async (query: string, variables: any) => {
      const name = /(?:query|mutation) (\w+)/.exec(query)![1];
      const answer = answers[name];
      return answer ? { kind: "answer", body: answer(variables) } : { kind: "no-answer", error: "timeout" };
    },
  };
});
vi.mock("@/actions/opsAlertOutbox", () => ({ enqueueOpsAlerts: async () => ({ failed: 0 }) }));

const q = async (sql: string, params: any[] = []) => (await env.pg.query<any>(sql, params)).rows;
const CUSTOMER = "gid://shopify/Customer/1";
const RETURN = "gid://shopify/Return/9";

async function seedRow(id: number, over: { action?: string | null; refunded?: boolean; credit?: boolean; newVariant?: string } = {}) {
  await q(`INSERT INTO orders (id, order_number) VALUES ('100', '#100') ON CONFLICT DO NOTHING`);
  await q(
    `INSERT INTO productsorder (id, order_id, line_item, product_id, title, variant_title, variant_id, price,
       quantity, changed, action, confirmed, return_id, return_line_item_id, transaction_id, refunded, credit,
       new_variant_id)
     VALUES ($1, '100', $2, 'p', 't', 'M', 'v', '50.00', 1, false, $3, true, $4, $5,
             'gid://shopify/OrderTransaction/7', $6, $7, $8)`,
    [
      id,
      String(700 + id),
      over.action === undefined ? "DEVOLUCIÓN" : over.action,
      RETURN,
      `gid://shopify/ReturnLineItem/${id}`,
      over.refunded ?? true,
      over.credit ?? false,
      over.newVariant ?? null,
    ]
  );
}

const lineFacts = (id: number, over: any = {}) => ({
  productsorderId: id,
  orderId: "100",
  orderNumber: "#100",
  returnId: RETURN,
  returnLineItemId: `gid://shopify/ReturnLineItem/${id}`,
  lineItemId: String(700 + id),
  action: "DEVOLUCIÓN",
  newVariantId: null,
  credit: false,
  refunded: true,
  price: "50.00",
  quantity: 1,
  giftCardId: null,
  isReplacement: false,
  ...over,
});

/** An approval Santi states: the amount is his, never computed. */
const approval = (
  id: number,
  over: Partial<{ amountCents: number; basis: "unpaid" | "swap"; capCents: number; approvedBy: string }> = {}
) => ({ productsorderId: id, basis: "unpaid" as const, amountCents: 4000, capCents: 5000, approvedBy: "santi", ...over });

/** Terms satisfying 0006's CHECKs: returned − replacement − fee = net. */
function terms(ids: number[], action = "DEVOLUCIÓN") {
  return {
    tender: "refund" as const,
    agreement: {
      tender: "refund",
      returnLegCents: 500,
      outboundLegCents: 0,
      chargedFeeCents: 500,
      returnedValueCents: 5000 * ids.length,
      replacementValueCents: 0,
      netCents: 5000 * ids.length - 500,
      stripeChargeCents: 0,
      waivedCents: 0,
      owedCents: 5000 * ids.length - 500,
      residualCents: 0,
      lines: [],
    } as any,
    lines: ids.map((id) => ({
      productsorder_id: id,
      shopify_line_item_id: String(700 + id),
      fulfillment_line_item_id: `gid://shopify/FulfillmentLineItem/${id}`,
      return_line_item_id: `gid://shopify/ReturnLineItem/${id}`,
      quantity: 1,
      action,
      new_variant_id: action === "CAMBIO" ? "gid://shopify/ProductVariant/42" : null,
      reason: null,
      notes: null,
      returned_cents: 5000,
      replacement_cents: 0,
      pay_cents: 4500,
      stripe_funded_cents: action === "CAMBIO" ? 300 : 0,
    })),
  };
}

const paid = (id: number) => ({
  productsorderId: id,
  lane: "refund" as const,
  cls: "paid" as const,
  reason: "refund R1",
  returnStatus: "CLOSED",
  evidence: { lane: "refund" as const, refundId: `gid://shopify/Refund/${id}`, amountCents: 4500, currency: "EUR" },
});
const ambiguous = (id: number) => ({
  productsorderId: id,
  lane: "refund" as const,
  cls: "ambiguous" as const,
  reason: "2 refunds paid this line",
  returnStatus: "CLOSED",
});
const unpaid = (id: number) => ({ ...ambiguous(id), cls: "unpaid" as const, reason: "none" });

async function write(lines: Array<{ id: number; c: any; over?: any }>, action?: string, funding: Map<number, any> = new Map()) {
  const { reconciliationRecord, recordReconciliation } = await import("@/lib/settlement/reconcileLedger");
  const t = terms(lines.map((l) => l.id), action);
  const record = reconciliationRecord(
    t,
    lines.map((l) => ({ line: lineFacts(l.id, l.over), classification: l.c, customerGid: CUSTOMER })),
    "test",
    undefined,
    funding
  );
  const [order] = await q(`SELECT * FROM orders WHERE id='100'`);
  return recordReconciliation({ ...order, orderNumber: order.order_number, returnMethod: null } as any, t, record);
}

beforeAll(() => env.ready);
beforeEach(async () => {
  await env.reset();
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("R1 --write", () => {
  it("paid → a done operation with its Shopify id, the line settled and refunded; re-running is a no-op", async () => {
    await seedRow(1, { refunded: false });
    const first = await write([{ id: 1, c: paid(1) }]);
    expect(first).toEqual({ recorded: true, settled: [1] });
    const ops = await q(`SELECT kind, state, effect_ref, amount_cents, resolved_by FROM settlement_operations`);
    expect(ops).toEqual([
      { kind: "process_refund", state: "done", effect_ref: "gid://shopify/Refund/1", amount_cents: 4500, resolved_by: "reconcile-legacy" },
    ]);
    expect((await q(`SELECT state, provenance FROM return_submissions`))[0]).toEqual({ state: "reconciled", provenance: "legacy" });
    expect((await q(`SELECT refunded FROM productsorder WHERE id=1`))[0].refunded).toBe(true);

    const again = await write([{ id: 1, c: paid(1) }]);
    expect(again.recorded).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM settlement_operations`))[0].n).toBe(1);
  });

  it("ambiguous → an unresolved operation and its alert, in one statement; the line is not settled", async () => {
    await seedRow(2);
    await write([{ id: 2, c: ambiguous(2) }]);
    const [op] = await q(`SELECT id, state, error FROM settlement_operations`);
    expect(op.state).toBe("unresolved");
    const alerts = await q(`SELECT dedupe_key FROM ops_alerts`);
    expect(alerts).toEqual([{ dedupe_key: `settlement-unresolved:${op.id}` }]);
    expect((await q(`SELECT settled_at FROM submission_lines`))[0].settled_at).toBeNull();
  });

  it("unpaid → nothing is written", async () => {
    await seedRow(3);
    const r = await write([{ id: 3, c: unpaid(3) }]);
    expect(r.recorded).toBe(false);
    expect((await q(`SELECT count(*)::int AS n FROM return_submissions`))[0].n).toBe(0);
  });

  const exchangePaid = (id: number) => ({
      productsorderId: id,
      lane: "exchange",
      cls: "paid",
      reason: "exchange order #500",
      returnStatus: "CLOSED",
      evidence: {
        lane: "exchange",
        orderGid: "gid://shopify/Order/500",
        orderName: "#500",
        lineItemId: "gid://shopify/LineItem/9",
        variantGid: "gid://shopify/ProductVariant/42",
        quantity: 1,
        unitCents: 6200,
        currency: "EUR",
      },
    });

  it("an exchange whose funding Stripe cannot allocate is a replacement BY ID with no funding: it refuses valuation (Codex #3/#5)", async () => {
    await seedRow(4, { action: "CAMBIO", newVariant: "42" });
    // The terms fixture carries stripe_funded 300 — it must never become funding.
    await write([{ id: 4, c: exchangePaid(4), over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO", new Map([[4, { ok: false, reason: "paid Stripe session cs_1 for order 100 carry no split" }]]));
    expect(await q(`SELECT * FROM replacement_lines`)).toEqual([]);
    expect(await q(`SELECT order_id, source_order_id, found_by FROM legacy_replacement_orders`)).toEqual([
      { order_id: "500", source_order_id: "100", found_by: "reconciliation" },
    ]);
    expect((await q(`SELECT dedupe_key FROM ops_alerts`)).map((r: any) => r.dedupe_key)).toContain("replacement-unfunded:500");
    const { replacementFundingOf } = await import("@/db/replacementLines");
    expect(await replacementFundingOf({ id: "500", sourceIdentifier: null })).toEqual({
      kind: "unfunded",
      sourceOrderId: "100",
      reason: "replacement-without-funding",
    });
    // Not even a census makes a known replacement ordinary.
    await q(`INSERT INTO legacy_replacement_census (orders_found, run_by) VALUES (1, 'test')`);
    expect((await replacementFundingOf({ id: "500", sourceIdentifier: null })).kind).toBe("unfunded");
  });

  it("a paid exchange records its replacement line, which values the order from then on (R4)", async () => {
    await seedRow(4, { action: "CAMBIO", newVariant: "42" });
    const c = {
      productsorderId: 4,
      lane: "exchange",
      cls: "paid",
      reason: "exchange order #500",
      returnStatus: "CLOSED",
      evidence: {
        lane: "exchange",
        orderGid: "gid://shopify/Order/500",
        orderName: "#500",
        lineItemId: "gid://shopify/LineItem/9",
        variantGid: "gid://shopify/ProductVariant/42",
        quantity: 1,
        unitCents: 6200,
        currency: "EUR",
      },
    };
    // Funding read from Stripe: no paid legacy session for the order → 0.
    await write([{ id: 4, c, over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO", new Map([[4, { ok: true, stripeFundedCents: 0, source: "stripe" }]]));
    const rl = await q(`SELECT order_id, line_item_id, source_productsorder_id, stripe_funded_cents FROM replacement_lines`);
    expect(rl).toEqual([{ order_id: "500", line_item_id: "gid://shopify/LineItem/9", source_productsorder_id: 4, stripe_funded_cents: 0 }]);
    const { replacementFundingOf } = await import("@/db/replacementLines");
    const funding = await replacementFundingOf({ id: "500", sourceIdentifier: null });
    expect(funding).toMatchObject({ kind: "funded", funding: { sourceOrderId: "100" } });
    expect((funding as any).funding.lineByLineItem.get("gid://shopify/LineItem/9")).toEqual({ totalCents: 5000, quantity: 1 });
  });
});

describe("a reconciliation record is never sent", () => {
  it("claim refuses it even after an operator rejects it; recovery never lists it", async () => {
    await seedRow(5);
    await write([{ id: 5, c: ambiguous(5) }]);
    const [op] = await q(`SELECT * FROM settlement_operations`);
    const ledger = await import("@/lib/settlement/ledger");
    expect(await ledger.recordReconciliationRejected(op.id, "no refund in Shopify", "santi")).toBe(true);
    expect((await q(`SELECT state FROM settlement_operations`))[0].state).toBe("rejected");
    expect(await ledger.claim(op.id, "00000000-0000-0000-0000-000000000001")).toBeNull();
    expect(await ledger.recoverableOperations(50)).toEqual([]);
  });
});

describe("standing records hold every payer (D1/D2 = A)", () => {
  const facts = () => {
    answers.SettlementAdmissionReturn = () => ({
      data: {
        return: {
          id: RETURN,
          status: "CLOSED",
          exchangeLineItems: { nodes: [] },
          returnLineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [6, 7].map((id) => ({
              id: `gid://shopify/ReturnLineItem/${id}`,
              quantity: 1,
              processedQuantity: 1,
              fulfillmentLineItem: { id: `gid://shopify/FulfillmentLineItem/${id}` },
            })),
          },
          reverseFulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [] },
          order: { id: "gid://shopify/Order/100", customer: { id: CUSTOMER }, totalPriceSet: null },
        },
      },
    });
  };

  it("an unresolved record refuses the approved payment; the operator's rejection then lets it through", async () => {
    facts();
    await seedRow(6);
    await write([{ id: 6, c: ambiguous(6) }]);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const held = await recordApprovedLegacySubmission([approval(6)]);
    expect(held).toMatchObject({ ok: false });
    expect((held as any).held).toMatch(/^reconciliation-unresolved:6/);

    const [op] = await q(`SELECT id FROM settlement_operations`);
    const { recordReconciliationRejected } = await import("@/lib/settlement/ledger");
    await recordReconciliationRejected(op.id, "no refund", "santi");
    const approved = await recordApprovedLegacySubmission([approval(6)]);
    expect(approved.ok).toBe(true);
    const subs = await q(`SELECT state, provenance FROM return_submissions ORDER BY state`);
    expect(subs).toEqual([
      { state: "accepted", provenance: "legacy" },
      { state: "reconciled", provenance: "legacy" },
    ]);
  });

  it("an approved line may be already marked refunded: that flag was never evidence", async () => {
    facts();
    await seedRow(7, { refunded: true });
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const r = await recordApprovedLegacySubmission([approval(7)]);
    expect(r.ok).toBe(true);
  });

  it("admission holds a line the reconciliation found paid", async () => {
    await seedRow(8, { refunded: false });
    // A legacy submission recorded before the reconciliation ran.
    await q(`INSERT INTO return_submissions (id, order_id, state, tender, return_method, return_leg_cents,
       outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
       stripe_charge_cents, waived_cents, owed_cents, residual_cents, provenance)
       VALUES ('11111111-1111-1111-1111-111111111111', '100', 'accepted', 'refund', 'CORREOS', 0, 0, 0, 5000, 0, 5000, 0, 0, 5000, 0, 'legacy')`);
    await q(`INSERT INTO submission_lines (submission_id, productsorder_id, shopify_line_item_id, quantity, action,
       returned_cents, replacement_cents, pay_cents, stripe_funded_cents, return_line_item_id)
       VALUES ('11111111-1111-1111-1111-111111111111', 8, '708', 1, 'DEVOLUCIÓN', 5000, 0, 5000, 0, 'gid://shopify/ReturnLineItem/8')`);
    await write([{ id: 8, c: paid(8) }]);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit("11111111-1111-1111-1111-111111111111", [8])).toEqual({ ok: false, held: "reconciliation-done:8" });
  });
});

describe("the operator resolves a reconciliation record", () => {
  it("--done records the evidence and settles the line; the runner's alert text is never used", async () => {
    await seedRow(9, { refunded: false });
    await write([{ id: 9, c: ambiguous(9) }]);
    const { getOperation } = await import("@/lib/settlement/ledger");
    const { resolveOperation } = await import("@/lib/settlement/operator");
    const [row] = await q(`SELECT id FROM settlement_operations`);
    const op = (await getOperation(row.id))!;
    const out = await resolveOperation(op, { verdict: "done", evidence: "gid://shopify/Refund/77", by: "santi" }, { write: true });
    expect(out).toMatchObject({ ok: true, written: true });
    expect((await q(`SELECT state, effect_ref FROM settlement_operations`))[0]).toEqual({ state: "done", effect_ref: "gid://shopify/Refund/77" });
    expect((await q(`SELECT refunded FROM productsorder WHERE id=9`))[0].refunded).toBe(true);
  });

  it("--rejected on a reconciliation record writes no 'refused by Shopify' alert", async () => {
    await seedRow(10);
    await write([{ id: 10, c: ambiguous(10) }]);
    const { getOperation } = await import("@/lib/settlement/ledger");
    const { resolveOperation } = await import("@/lib/settlement/operator");
    const [row] = await q(`SELECT id FROM settlement_operations`);
    await resolveOperation((await getOperation(row.id))!, { verdict: "rejected", evidence: "nothing in Shopify", by: "santi" }, { write: true });
    const keys = (await q(`SELECT dedupe_key FROM ops_alerts`)).map((r) => r.dedupe_key);
    expect(keys.some((k: string) => k.startsWith("settlement-rejected:"))).toBe(false);
  });
});

// Santi, 30 Oct: "You set each amount", and an approved payment is admissible
// on a return that is no longer OPEN — only on the authority of its 0010 row.
describe("an approved payment is the amount Santi stated (D1/D2, 30 Oct)", () => {
  const shopify = (status: string, processedQuantity: number, ids: number[] = [20]) => {
    answers.SettlementAdmissionReturn = () => ({
      data: {
        return: {
          id: RETURN,
          status,
          exchangeLineItems: { nodes: [] },
          returnLineItems: {
            pageInfo: { hasNextPage: false },
            nodes: ids.map((id) => ({
              id: `gid://shopify/ReturnLineItem/${id}`,
              quantity: 1,
              processedQuantity,
              fulfillmentLineItem: { id: `gid://shopify/FulfillmentLineItem/${id}` },
            })),
          },
          reverseFulfillmentOrders: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                lineItems: {
                  pageInfo: { hasNextPage: false },
                  nodes: ids.map((id) => ({
                    id: `gid://shopify/ReverseFulfillmentOrderLineItem/${id}`,
                    totalQuantity: 1,
                    fulfillmentLineItem: { id: `gid://shopify/FulfillmentLineItem/${id}` },
                  })),
                },
              },
            ],
          },
          order: { id: "gid://shopify/Order/100", customer: { id: CUSTOMER }, totalPriceSet: null },
        },
      },
    });
    answers.SettlementAdmissionPayingOrder = () => ({
      data: {
        order: {
          id: "gid://shopify/Order/100",
          totalPriceSet: null,
          transactions: [
            { id: "gid://shopify/OrderTransaction/7", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "50.00" } } },
          ],
        },
      },
    });
  };
  const approve = async (id: number, over: Parameters<typeof approval>[1] = {}) => {
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    return recordApprovedLegacySubmission([approval(id, over)]);
  };

  it("records the approval with its submission; that line pays exactly the stated amount", async () => {
    shopify("CLOSED", 1);
    await seedRow(20);
    const sub = await approve(20, { amountCents: 3100, approvedBy: "santi" });
    expect(sub.ok).toBe(true);
    const id = (sub as any).submissionId;
    expect(await q(`SELECT productsorder_id, submission_id, basis, amount_cents, cap_cents, approved_by FROM settlement_approvals`)).toEqual([
      { productsorder_id: 20, submission_id: id, basis: "unpaid", amount_cents: 3100, cap_cents: 5000, approved_by: "santi" },
    ]);
    expect(await q(`SELECT pay_cents, returned_cents, replacement_cents FROM submission_lines`)).toEqual([
      { pay_cents: 3100, returned_cents: 5000, replacement_cents: 1900 },
    ]);
    expect(await q(`SELECT state, provenance, net_cents, owed_cents, charged_fee_cents FROM return_submissions`)).toEqual([
      { state: "accepted", provenance: "legacy", net_cents: 3100, owed_cents: 3100, charged_fee_cents: 0 },
    ]);
  });

  it("refuses an amount over the cap, zero, or with no approver — and 0010 refuses it again", async () => {
    shopify("CLOSED", 1, [21]);
    await seedRow(21);
    expect(await approve(21, { amountCents: 5001 })).toMatchObject({ ok: false });
    expect(await approve(21, { amountCents: 0 })).toMatchObject({ ok: false });
    expect(await approve(21, { amountCents: 10.5 })).toMatchObject({ ok: false });
    expect(await approve(21, { approvedBy: "  " })).toMatchObject({ ok: false });
    expect(await q(`SELECT * FROM return_submissions`)).toEqual([]);
    // The violation is caught in the database: an error crossing PGlite's
    // protocol corrupts its later queries. Accepted → the block raises.

    // 0010 holds the same rule. (A violating insert is not run here: an
    // error inside PGlite corrupts its later queries.)
    const checks = await q(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'settlement_approvals'::regclass AND contype = 'c' ORDER BY conname`);
    expect(checks.map((c: any) => c.def).join(" | ")).toMatch(/amount_cents <= cap_cents/);
    expect(checks.map((c: any) => c.def).join(" | ")).toMatch(/amount_cents > 0/);
    expect(await q(`SELECT * FROM settlement_approvals`)).toEqual([]);
  });

  it("admits it on a CLOSED, processed return: money only, no goods operation", async () => {
    shopify("CLOSED", 1, [22]);
    await seedRow(22);
    const sub = await approve(22, { amountCents: 3100 });
    expect(sub.ok).toBe(true);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit((sub as any).submissionId, [22])).toMatchObject({ ok: true, admitted: [22] });
    expect(await q(`SELECT kind, amount_cents, state FROM settlement_operations`)).toEqual([
      { kind: "root_refund", amount_cents: 3100, state: "pending" },
    ]);
  });

  it("admits it on an OPEN return whose line is unprocessed: goods, and the money outside them", async () => {
    shopify("OPEN", 0, [23]);
    await seedRow(23);
    const sub = await approve(23, { amountCents: 2000 });
    expect(sub.ok).toBe(true);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit((sub as any).submissionId, [23])).toMatchObject({ ok: true });
    const ops = await q(`SELECT kind, amount_cents FROM settlement_operations ORDER BY kind`);
    expect(ops).toEqual([
      { kind: "process_goods", amount_cents: 0 },
      { kind: "root_refund", amount_cents: 2000 },
    ]);
  });

  it("an unapproved line on a CLOSED return is still held by the OPEN gate", async () => {
    shopify("CLOSED", 1, [24]);
    await seedRow(24, { refunded: false });
    await q(`INSERT INTO return_submissions (id, order_id, state, tender, return_method, return_leg_cents,
       outbound_leg_cents, charged_fee_cents, returned_value_cents, replacement_value_cents, net_cents,
       stripe_charge_cents, waived_cents, owed_cents, residual_cents, provenance)
       VALUES ('33333333-3333-3333-3333-333333333333', '100', 'accepted', 'refund', 'CORREOS', 0, 0, 0, 5000, 0, 5000, 0, 0, 5000, 0, 'legacy')`);
    await q(`INSERT INTO submission_lines (submission_id, productsorder_id, shopify_line_item_id, quantity, action,
       returned_cents, replacement_cents, pay_cents, stripe_funded_cents, fulfillment_line_item_id, return_line_item_id)
       VALUES ('33333333-3333-3333-3333-333333333333', 24, '724', 1, 'DEVOLUCIÓN', 5000, 0, 5000, 0,
               'gid://shopify/FulfillmentLineItem/24', 'gid://shopify/ReturnLineItem/24')`);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit("33333333-3333-3333-3333-333333333333", [24])).toEqual({ ok: false, held: "return-not-open:CLOSED" });
    expect(await q(`SELECT * FROM settlement_operations`)).toEqual([]);
  });

  it("a swap approval pays the owed part of a recorded exchange; no second replacement order", async () => {
    shopify("CLOSED", 1, [25]);
    await seedRow(25, { action: "CAMBIO", newVariant: "42" });
    const c = {
      productsorderId: 25,
      lane: "exchange",
      cls: "paid",
      reason: "exchange order #500",
      returnStatus: "CLOSED",
      evidence: {
        lane: "exchange",
        orderGid: "gid://shopify/Order/500",
        orderName: "#500",
        lineItemId: "gid://shopify/LineItem/9",
        variantGid: "gid://shopify/ProductVariant/42",
        quantity: 1,
        unitCents: 3000,
        currency: "EUR",
      },
    };
    await write([{ id: 25, c, over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO");
    // The same line approved as `unpaid` is refused: it WAS paid.
    expect(await approve(25, { amountCents: 2000 })).toMatchObject({ ok: false, held: "reconciliation-done:25" });
    const sub = await approve(25, { basis: "swap", amountCents: 2000, capCents: 2000 });
    expect(sub.ok).toBe(true);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit((sub as any).submissionId, [25])).toMatchObject({ ok: true });
    const ops = await q(`SELECT o.kind, o.amount_cents FROM settlement_operations o
       JOIN return_submissions s ON s.id = o.submission_id WHERE s.state = 'accepted'`);
    expect(ops).toEqual([{ kind: "root_refund", amount_cents: 2000 }]);
  });
});

// Concern 6: a confirmed line with no Shopify return is listed as needs-human
// and no write path takes it.
describe("a line with no Shopify return: needs-human, and nothing writes it", () => {
  it("R1 records nothing, an approval is refused, D3 is refused, the legacy recorder is refused", async () => {
    await seedRow(30, { action: null });
    await q(`UPDATE productsorder SET return_id = NULL, return_line_item_id = NULL WHERE id = 30`);
    const c = { productsorderId: 30, lane: null, cls: "needs-human", reason: "no Shopify return on the line", returnStatus: null };
    const { reconciliationRecord } = await import("@/lib/settlement/reconcileLedger");
    const record = reconciliationRecord(
      terms([30]),
      [{ line: lineFacts(30, { returnId: null, returnLineItemId: null, action: null }), classification: c as any, customerGid: CUSTOMER }],
      "test"
    );
    expect(record.ops).toEqual([]);

    const { recordApprovedLegacySubmission, submissionForRow } = await import("@/lib/settlement/legacy");
    expect(await recordApprovedLegacySubmission([approval(30)])).toEqual({ ok: false, held: "not-confirmed" });
    expect(await submissionForRow(30)).toEqual({ ok: false, held: "not-confirmed" });
    const { decideLineAction } = await import("@/lib/settlement/lineAction");
    expect((await decideLineAction({ productsorderId: 30, action: "DEVOLUCIÓN", newVariantId: null, by: "santi", evidence: "x" })).ok).toBe(false);

    expect(await q(`SELECT action, refunded FROM productsorder WHERE id = 30`)).toEqual([{ action: null, refunded: true }]);
    expect(await q(`SELECT count(*)::int AS n FROM return_submissions`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM line_action_decisions`)).toEqual([{ n: 0 }]);
  });
});

// ── Codex S3 review (30 Oct) ────────────────────────────────────────────────
describe("approvals are resumable (Codex #6)", () => {
  const shopifyClosed = (id: number) => {
    answers.SettlementAdmissionReturn = () => ({
      data: {
        return: {
          id: RETURN,
          status: "CLOSED",
          exchangeLineItems: { nodes: [] },
          returnLineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [{ id: `gid://shopify/ReturnLineItem/${id}`, quantity: 1, processedQuantity: 1, fulfillmentLineItem: { id: `gid://shopify/FulfillmentLineItem/${id}` } }],
          },
          reverseFulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [] },
          order: { id: "gid://shopify/Order/100", customer: { id: CUSTOMER }, totalPriceSet: null },
        },
      },
    });
    answers.SettlementAdmissionPayingOrder = () => ({
      data: {
        order: {
          id: "gid://shopify/Order/100",
          totalPriceSet: null,
          transactions: [{ id: "gid://shopify/OrderTransaction/7", kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amountSet: { shopMoney: { amount: "50.00" } } }],
        },
      },
    });
  };

  it("crash between the approval commit and admission: an identical rerun resumes the same obligation, never a second", async () => {
    shopifyClosed(40);
    await seedRow(40);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const first = await recordApprovedLegacySubmission([approval(40, { amountCents: 3000 })]);
    expect(first.ok).toBe(true);
    // ...the process stopped here: no admission ran.
    const again = await recordApprovedLegacySubmission([approval(40, { amountCents: 3000 })]);
    expect(again).toEqual(first);
    expect(await q(`SELECT count(*)::int AS n FROM settlement_approvals`)).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int AS n FROM return_submissions`)).toEqual([{ n: 1 }]);
    const { admit } = await import("@/lib/settlement/admission");
    expect(await admit((again as any).submissionId, [40])).toMatchObject({ ok: true });
    expect(await admit((again as any).submissionId, [40])).toMatchObject({ ok: true });
    expect(await q(`SELECT kind, amount_cents FROM settlement_operations`)).toEqual([{ kind: "root_refund", amount_cents: 3000 }]);
  });

  it("a different approval of the same line is refused, not recorded twice", async () => {
    shopifyClosed(41);
    await seedRow(41);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    expect((await recordApprovedLegacySubmission([approval(41, { amountCents: 3000 })])).ok).toBe(true);
    expect(await recordApprovedLegacySubmission([approval(41, { amountCents: 3100 })])).toEqual({ ok: false, held: "approval-differs:41" });
    expect(await q(`SELECT count(*)::int AS n FROM settlement_approvals`)).toEqual([{ n: 1 }]);
  });

  it("recovery admits an approval that was never admitted, once", async () => {
    shopifyClosed(42);
    await seedRow(42);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const sub = await recordApprovedLegacySubmission([approval(42, { amountCents: 2500 })]);
    const { approvalsAwaitingAdmission } = await import("@/lib/settlement/ledger");
    expect(await approvalsAwaitingAdmission()).toEqual([{ submissionId: (sub as any).submissionId, lines: [42] }]);
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    // limit 0: admit only — running the admitted refund is the ledger's usual path.
    const report = await recoverSettlements({ deadline: Date.now() + 60_000, limit: 0 });
    expect(report.admittedApprovals).toEqual([{ submission: (sub as any).submissionId, lines: [42], outcome: "admitted" }]);
    expect(await approvalsAwaitingAdmission()).toEqual([]);
    await recoverSettlements({ deadline: Date.now() + 60_000, limit: 0 });
    expect(await q(`SELECT kind, amount_cents FROM settlement_operations`)).toEqual([{ kind: "root_refund", amount_cents: 2500 }]);
  });

  it("a held admission stays awaiting and alerts once per reason", async () => {
    await seedRow(43);
    shopifyClosed(43);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const sub = await recordApprovedLegacySubmission([approval(43, { amountCents: 2500 })]);
    delete answers.SettlementAdmissionReturn; // Shopify stops answering
    const { recoverSettlements } = await import("@/lib/settlement/recovery");
    const report = await recoverSettlements({ deadline: Date.now() + 60_000, limit: 0 });
    expect(report.admittedApprovals[0]).toMatchObject({ submission: (sub as any).submissionId, outcome: expect.stringMatching(/^held:/) });
    const { approvalsAwaitingAdmission } = await import("@/lib/settlement/ledger");
    expect(await approvalsAwaitingAdmission()).toHaveLength(1);
  });
});

describe("line totals round once on the approval path (Codex #7)", () => {
  it("€31.01 over two units (stored 15.505): cap and returned_cents are 3101, and 3102 is refused", async () => {
    answers.SettlementAdmissionReturn = () => ({
      data: {
        return: {
          id: RETURN,
          status: "CLOSED",
          exchangeLineItems: { nodes: [] },
          returnLineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [{ id: "gid://shopify/ReturnLineItem/44", quantity: 2, processedQuantity: 2, fulfillmentLineItem: { id: "gid://shopify/FulfillmentLineItem/44" } }],
          },
          reverseFulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [] },
          order: { id: "gid://shopify/Order/100", customer: { id: CUSTOMER }, totalPriceSet: null },
        },
      },
    });
    await seedRow(44);
    await q(`UPDATE productsorder SET price = '15.505', quantity = 2 WHERE id = 44`);
    const { approvalBasisOf } = await import("@/lib/settlement/reconcile");
    const basis = approvalBasisOf({ price: "15.505", quantity: 2 }, { productsorderId: 44, lane: "refund", cls: "unpaid", reason: "", returnStatus: "CLOSED" });
    expect(basis).toEqual({ ok: true, basis: "unpaid", capCents: 3101 });
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    expect(await recordApprovedLegacySubmission([approval(44, { amountCents: 3102, capCents: 3101 })])).toMatchObject({ ok: false });
    expect((await recordApprovedLegacySubmission([approval(44, { amountCents: 3101, capCents: 3101 })])).ok).toBe(true);
    expect(await q(`SELECT returned_cents, pay_cents, replacement_cents FROM submission_lines`)).toEqual([
      { returned_cents: 3101, pay_cents: 3101, replacement_cents: 0 },
    ]);
  });
});

describe("effect decisions (Codex #1/#5)", () => {
  it("one decision per effect, with who and why; binds needs a confirmed line", async () => {
    await seedRow(45);
    const { decideEffect, effectDecisions } = await import("@/lib/settlement/effectDecisions");
    expect(await decideEffect({ effectId: "gid://shopify/Refund/9", verdict: "binds", productsorderId: 999, by: "santi", evidence: "x" }))
      .toMatchObject({ ok: false });
    expect(await decideEffect({ effectId: "gid://shopify/Refund/9", verdict: "binds", productsorderId: 45, by: "santi", evidence: "admin refund for line 45" }))
      .toEqual({ ok: true });
    expect(await decideEffect({ effectId: "gid://shopify/Refund/9", verdict: "excludes", productsorderId: null, by: "santi", evidence: "changed my mind" }))
      .toMatchObject({ ok: false });
    expect(await decideEffect({ effectId: "cs_1", verdict: "excludes", productsorderId: null, by: "", evidence: "x" })).toMatchObject({ ok: false });
    expect(await effectDecisions()).toEqual(new Map([["gid://shopify/Refund/9", { verdict: "binds", productsorderId: 45 }]]));
  });

  it("the ledger's done effects are identity: recordedEffects lists them by line", async () => {
    await seedRow(46, { refunded: false });
    await write([{ id: 46, c: paid(46) }]);
    const { recordedEffects } = await import("@/lib/settlement/effectDecisions");
    expect((await recordedEffects()).get("gid://shopify/Refund/46")).toEqual([46]);
  });
});

describe("the census: every pre-S2 exchange order, by id (Codex #3)", () => {
  it("records every Change-tagged order with its exact source, then the census; ordinary only after it", async () => {
    await q(`INSERT INTO orders (id, order_number) VALUES ('100', '#100'), ('101', '#101') ON CONFLICT DO NOTHING`);
    const pages = [
      { nodes: [{ id: "gid://shopify/Order/500", tags: ["Change", "Order #100"] }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [{ id: "gid://shopify/Order/501", tags: ["Change", "Order #999"] }], pageInfo: { hasNextPage: false, endCursor: null } },
    ];
    answers.ReconcileChangeOrders = (v: any) => ({ data: { orders: v.after ? pages[1] : pages[0] } });
    const census = await import("@/lib/settlement/replacementCensus");
    const found = await census.readChangeOrders();
    expect(found).toMatchObject({ ok: true });
    const rows = census.censusRows((found as any).value, await census.ourOrderTags());
    expect(rows).toEqual([
      { order_id: "500", source_order_id: "100" },
      { order_id: "501", source_order_id: null },
    ]);
    const { replacementFundingOf } = await import("@/db/replacementLines");
    expect((await replacementFundingOf({ id: "777", sourceIdentifier: null })).kind).toBe("unprovable");
    await census.recordCensus(rows, "santi");
    expect(await census.censusComplete()).toBe(true);
    expect(await replacementFundingOf({ id: "501", sourceIdentifier: null })).toEqual({
      kind: "unfunded",
      sourceOrderId: null,
      reason: "replacement-without-funding",
    });
    expect(await replacementFundingOf({ id: "777", sourceIdentifier: null })).toEqual({ kind: "not-settlement" });
  });

  it("an unreadable page means no census at all", async () => {
    answers.ReconcileChangeOrders = (v: any) =>
      v.after ? undefined : { data: { orders: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } } } };
    const census = await import("@/lib/settlement/replacementCensus");
    expect((await census.readChangeOrders()).ok).toBe(false);
  });

  it("an order already stored with exchange_of is a replacement: unfunded, never ordinary", async () => {
    await q(`INSERT INTO orders (id, order_number, exchange_of) VALUES ('600', '#600', '100')`);
    await q(`INSERT INTO legacy_replacement_census (orders_found, run_by) VALUES (0, 'test')`);
    const { replacementFundingOf } = await import("@/db/replacementLines");
    expect(await replacementFundingOf({ id: "600", sourceIdentifier: null })).toMatchObject({ kind: "unfunded", sourceOrderId: "100" });
  });

  it("an operator's done on a legacy exchange records the order as a replacement, with no invented funding", async () => {
    await seedRow(47, { action: "CAMBIO", newVariant: "42", refunded: false });
    await write([{ id: 47, c: { productsorderId: 47, lane: "exchange", cls: "ambiguous", reason: "x", returnStatus: "CLOSED" }, over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO");
    answers.ReconcileOrderById = () => ({
      data: {
        order: {
          id: "gid://shopify/Order/510",
          name: "#510",
          tags: ["Change", "Order #100"],
          customer: { id: CUSTOMER },
          lineItems: { nodes: [{ id: "gid://shopify/LineItem/91", quantity: 1, variant: { id: "gid://shopify/ProductVariant/42" }, originalUnitPriceSet: { shopMoney: { amount: "30.00", currencyCode: "EUR" } } }] },
        },
      },
    });
    const [row] = await q(`SELECT id FROM settlement_operations`);
    const { getOperation } = await import("@/lib/settlement/ledger");
    const { resolveOperation } = await import("@/lib/settlement/operator");
    const out = await resolveOperation((await getOperation(row.id))!, { verdict: "done", evidence: "found it", by: "santi", orderGid: "gid://shopify/Order/510" }, { write: true });
    expect(out).toMatchObject({ ok: true, written: true });
    expect(await q(`SELECT * FROM replacement_lines`)).toEqual([]);
    expect(await q(`SELECT order_id, source_order_id, found_by FROM legacy_replacement_orders`)).toEqual([
      { order_id: "510", source_order_id: "100", found_by: "operator" },
    ]);
  });
});

describe("no historical figure is rebuilt (Codex #5)", () => {
  it("a reconciled submission's terms carry the exact returned total and nothing else", async () => {
    answers.SettlementAdmissionReturn = () => ({
      data: {
        return: {
          id: RETURN,
          status: "CLOSED",
          exchangeLineItems: { nodes: [] },
          returnLineItems: {
            pageInfo: { hasNextPage: false },
            nodes: [{ id: "gid://shopify/ReturnLineItem/48", quantity: 2, processedQuantity: 2, fulfillmentLineItem: { id: "gid://shopify/FulfillmentLineItem/48" } }],
          },
          reverseFulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [] },
          order: { id: "gid://shopify/Order/100", customer: { id: CUSTOMER }, totalPriceSet: null },
        },
      },
    });
    await seedRow(48, { action: "CAMBIO", newVariant: "gid://shopify/ProductVariant/42" });
    await q(`UPDATE productsorder SET price = '15.505', quantity = 2 WHERE id = 48`);
    const { db } = env;
    const { productsOrder } = await import("@/db/schema");
    const rows = await db.select().from(productsOrder);
    const { recordedTerms } = await import("@/lib/settlement/legacyTerms");
    const t = await recordedTerms(rows as any);
    expect(t.ok).toBe(true);
    const { agreement, lines } = (t as any).terms;
    expect(lines.map((l: any) => [l.returned_cents, l.replacement_cents, l.pay_cents, l.stripe_funded_cents])).toEqual([[3101, 0, 0, 0]]);
    expect([agreement.chargedFeeCents, agreement.netCents, agreement.owedCents, agreement.stripeChargeCents]).toEqual([0, 3101, 0, 0]);
  });

  it("an exchange recorded with no funding read writes no replacement line (never the terms' figure)", async () => {
    await seedRow(49, { action: "CAMBIO", newVariant: "42" });
    const c = {
      productsorderId: 49,
      lane: "exchange",
      cls: "paid",
      reason: "exchange order #520",
      returnStatus: "CLOSED",
      evidence: {
        lane: "exchange",
        orderGid: "gid://shopify/Order/520",
        orderName: "#520",
        lineItemId: "gid://shopify/LineItem/92",
        variantGid: "gid://shopify/ProductVariant/42",
        quantity: 1,
        unitCents: 6200,
        currency: "EUR",
      },
    };
    await write([{ id: 49, c, over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO");
    expect(await q(`SELECT * FROM replacement_lines`)).toEqual([]);
    expect(await q(`SELECT order_id FROM legacy_replacement_orders`)).toEqual([{ order_id: "520" }]);
  });
});

describe("census sources are exact", () => {
  it("a tag that matches two of our orders, or two tags naming different orders, give no source", async () => {
    const { censusRows } = await import("@/lib/settlement/replacementCensus");
    const ours = new Map([
      ["Order #100", ["100"]],
      ["Order #101", ["101"]],
      ["Order #200", ["200", "201"]],
    ]);
    expect(
      censusRows(
        [
          { id: "gid://shopify/Order/1", tags: ["Change", "Order #200"] },
          { id: "gid://shopify/Order/2", tags: ["Change", "Order #100", "Order #101"] },
          { id: "gid://shopify/Order/3", tags: ["Change", "Order #1000"] },
        ],
        ours
      )
    ).toEqual([
      { order_id: "1", source_order_id: null },
      { order_id: "2", source_order_id: null },
      { order_id: "3", source_order_id: null },
    ]);
  });
});
