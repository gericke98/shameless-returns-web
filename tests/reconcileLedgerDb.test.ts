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

async function write(lines: Array<{ id: number; c: any; over?: any }>, action?: string) {
  const { reconciliationRecord, recordReconciliation } = await import("@/lib/settlement/reconcileLedger");
  const t = terms(lines.map((l) => l.id), action);
  const record = reconciliationRecord(
    t,
    lines.map((l) => ({ line: lineFacts(l.id, l.over), classification: l.c, customerGid: CUSTOMER })),
    "test"
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
    await write([{ id: 4, c, over: { action: "CAMBIO", newVariantId: "42" } }], "CAMBIO");
    const rl = await q(`SELECT order_id, line_item_id, source_productsorder_id, stripe_funded_cents FROM replacement_lines`);
    expect(rl).toEqual([{ order_id: "500", line_item_id: "gid://shopify/LineItem/9", source_productsorder_id: 4, stripe_funded_cents: 300 }]);
    const { replacementFundingOf } = await import("@/db/replacementLines");
    const funding = await replacementFundingOf({ id: "500", sourceIdentifier: null });
    expect(funding).toMatchObject({ kind: "funded", funding: { sourceOrderId: "100" } });
    expect((funding as any).funding.lineByLineItem.get("gid://shopify/LineItem/9")).toEqual({ totalCents: 5300, quantity: 1 });
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
  const deps = { feeTable: async () => ({ "*": [{ maxGrams: 1_000_000, returnFeeCents: 500, exchangeFeeCents: 500 }] }), catalogue: async () => [] };

  it("an unresolved record refuses the approved payment; the operator's rejection then lets it through", async () => {
    facts();
    await seedRow(6);
    await write([{ id: 6, c: ambiguous(6) }]);
    const { recordApprovedLegacySubmission } = await import("@/lib/settlement/legacy");
    const held = await recordApprovedLegacySubmission([6], deps as any);
    expect(held).toMatchObject({ ok: false });
    expect((held as any).held).toMatch(/^reconciliation-unresolved:6/);

    const [op] = await q(`SELECT id FROM settlement_operations`);
    const { recordReconciliationRejected } = await import("@/lib/settlement/ledger");
    await recordReconciliationRejected(op.id, "no refund", "santi");
    const approved = await recordApprovedLegacySubmission([6], deps as any);
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
    const r = await recordApprovedLegacySubmission([7], deps as any);
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
