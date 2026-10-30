import { describe, expect, it } from "vitest";
import {
  afterOperatorRejection,
  approvalBasisOf,
  readsNeeded,
  classifyLine,
  lineValues,
  parseApprovalFile,
  reconcilePopulation,
  groupKey,
  returnOwnedRead,
  judgeLegacyExchangeOrder,
  sharedIdentity,
  type LineFacts,
  type LineReads,
  type ReturnEvidence,
} from "@/lib/settlement/reconcile";
import { exchangeOrderSearch } from "@/lib/settlement/reconcileReads";

// S3 R1: each lane × {evidence 0/1/2, recipient mismatch, wrong currency,
// unreadable, truncated}, by explicit identity only.

const CUSTOMER = "gid://shopify/Customer/1";
const line = (over: Partial<LineFacts> = {}): LineFacts => ({
  productsorderId: 1,
  orderId: "100",
  orderNumber: "#100",
  returnId: "gid://shopify/Return/9",
  returnLineItemId: "gid://shopify/ReturnLineItem/5",
  lineItemId: "777",
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
const tx = (status = "SUCCESS", amount = "45.00", currencyCode = "EUR") => ({
  kind: "REFUND",
  status,
  amountSet: { presentmentMoney: { amount, currencyCode } },
  parentTransaction: { id: "gid://shopify/OrderTransaction/1" },
});
const refund = (id: string, lineItem: string, txs: any[]) => ({
  id,
  refundLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ lineItem: { id: lineItem } }] },
  transactions: { pageInfo: { hasNextPage: false }, nodes: txs },
});
const ret = (over: Partial<ReturnEvidence> = {}): ReturnEvidence => ({
  id: "gid://shopify/Return/9",
  status: "CLOSED",
  order: { id: "gid://shopify/Order/100", presentmentCurrencyCode: "EUR", customer: { id: CUSTOMER } },
  exchangeLineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
  refunds: { pageInfo: { hasNextPage: false }, nodes: [] },
  ...over,
});
const reads = (over: Partial<LineReads> = {}): LineReads => ({ ret: { ok: true, value: ret() }, ...over });
const classify = (l: LineFacts, r: LineReads, all: LineFacts[] = [l]) => classifyLine(l, r, sharedIdentity(all));
const LI = "gid://shopify/LineItem/777";

describe("refund lane", () => {
  it("one paying refund naming the line → paid, with its id and amount", () => {
    const c = classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [refund("R1", LI, [tx()])] } }) } }));
    expect(c).toMatchObject({ cls: "paid", lane: "refund", evidence: { refundId: "R1", amountCents: 4500, currency: "EUR" } });
  });
  it("no refund names the line, return closed → unpaid", () => {
    const other = refund("R1", "gid://shopify/LineItem/888", [tx()]);
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [other] } }) } })).cls).toBe("unpaid");
  });
  it("a refund naming the line that moved no money is not a payment → unpaid", () => {
    const zero = refund("R1", LI, []);
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [zero] } }) } })).cls).toBe("unpaid");
  });
  it("two paying refunds → ambiguous", () => {
    const two = [refund("R1", LI, [tx()]), refund("R2", LI, [tx()])];
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: two } }) } })).cls).toBe("ambiguous");
  });
  it("a refund in another currency than the order → ambiguous", () => {
    const usd = refund("R1", LI, [tx("SUCCESS", "45.00", "USD")]);
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [usd] } }) } })).cls).toBe("ambiguous");
  });
  it("a pending refund transaction → ambiguous", () => {
    const pending = refund("R1", LI, [tx("PENDING")]);
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [pending] } }) } })).cls).toBe("ambiguous");
  });
  it("refunds truncated → ambiguous, never unpaid", () => {
    const r = ret({ refunds: { pageInfo: { hasNextPage: true }, nodes: [] } });
    expect(classify(line(), reads({ ret: { ok: true, value: r } })).cls).toBe("ambiguous");
  });
  it("return unreadable → ambiguous", () => {
    expect(classify(line(), reads({ ret: { ok: false, error: "timeout" } })).cls).toBe("ambiguous");
  });
  it("no evidence on a cancelled return → ambiguous, not unpaid", () => {
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ status: "CANCELED" }) } })).cls).toBe("ambiguous");
  });
});

describe("root refund lane (a line on a replacement order)", () => {
  const l = line({ isReplacement: true });
  const root = (refunds: any[] | null) =>
    reads({
      rootRefunds: {
        ok: true,
        value: { orderGid: "gid://shopify/Order/1", presentmentCurrencyCode: "EUR", refunds },
      },
    });
  const marked = (id: string, txs = [tx()]) => ({
    id,
    note: `[gid://shopify/ReturnLineItem/5] Return from replacement order #100`,
    transactions: { pageInfo: { hasNextPage: false }, nodes: txs },
  });
  it("one refund carrying the marker → paid on the root", () => {
    expect(classify(l, root([marked("R1")]))).toMatchObject({
      cls: "paid",
      evidence: { lane: "root_refund", refundId: "R1", rootOrderGid: "gid://shopify/Order/1" },
    });
  });
  it("an unmarked refund that moved money on the root is NOT absence of payment → ambiguous, naming it", () => {
    // Codex S3 #1: refunded by hand on the root, no marker. Words in the note
    // are never read; the refund stays unattributed until a human decides.
    const c = classify(l, root([{ id: "R1", note: "Return from replacement order #100", transactions: { nodes: [tx()] } }]));
    expect(c).toMatchObject({ cls: "ambiguous", unattributed: ["R1"] });
  });
  it("two marked → ambiguous; truncated root → ambiguous", () => {
    expect(classify(l, root([marked("R1"), marked("R2")])).cls).toBe("ambiguous");
    expect(classify(l, root(null)).cls).toBe("ambiguous");
  });
});

describe("credit lane", () => {
  const card = (over: any = {}) => ({
    id: "gid://shopify/GiftCard/3",
    initialValue: { amount: "51.75", currencyCode: "EUR" },
    customer: { id: CUSTOMER },
    ...over,
  });
  const l = line({ credit: true, giftCardId: "gid://shopify/GiftCard/3" });
  it("the stored card, the order's customer, EUR → paid", () => {
    expect(classify(l, reads({ giftCard: { ok: true, value: card() } }))).toMatchObject({
      cls: "paid",
      evidence: { lane: "credit", giftCardId: "gid://shopify/GiftCard/3", amountCents: 5175 },
    });
  });
  it("another customer's card → ambiguous (recipient mismatch)", () => {
    const c = classify(l, reads({ giftCard: { ok: true, value: card({ customer: { id: "gid://shopify/Customer/2" } }) } }));
    expect(c.cls).toBe("ambiguous");
  });
  it("a card in another currency → ambiguous", () => {
    const c = classify(l, reads({ giftCard: { ok: true, value: card({ initialValue: { amount: "1", currencyCode: "USD" } }) } }));
    expect(c.cls).toBe("ambiguous");
  });
  it("one card id on two lines → ambiguous for both", () => {
    const twin = { ...l, productsorderId: 2 };
    expect(classify(l, reads({ giftCard: { ok: true, value: card() } }), [l, twin]).cls).toBe("ambiguous");
  });
  it("card not found, or unreadable → ambiguous", () => {
    expect(classify(l, reads({ giftCard: { ok: true, value: null } })).cls).toBe("ambiguous");
    expect(classify(l, reads({ giftCard: { ok: false, error: "x" } })).cls).toBe("ambiguous");
  });
  it("no stored card id → ambiguous: there is no identity to search by", () => {
    expect(classify(line({ credit: true }), reads()).cls).toBe("ambiguous");
  });
});

describe("exchange lane", () => {
  const V = "gid://shopify/ProductVariant/42";
  const l = line({ action: "CAMBIO", newVariantId: "42" });
  const order = (over: any = {}) => ({
    id: "gid://shopify/Order/500",
    name: "#500",
    tags: ["amphora_shipped", "Change", "Order #100"],
    customer: { id: CUSTOMER },
    lineItems: {
      pageInfo: { hasNextPage: false },
      nodes: [{ id: "gid://shopify/LineItem/9", quantity: 1, variant: { id: V }, originalUnitPriceSet: { shopMoney: { amount: "62.00", currencyCode: "EUR" } } }],
    },
    ...over,
  });
  const search = (nodes: any[], truncated = false) => reads({ exchangeOrders: { ok: true, value: { truncated, nodes } } });
  it("exactly one tagged order with the variant → paid, with its line and list price", () => {
    expect(classify(l, search([order()]))).toMatchObject({
      cls: "paid",
      evidence: { lane: "exchange", orderGid: "gid://shopify/Order/500", lineItemId: "gid://shopify/LineItem/9", unitCents: 6200 },
    });
  });
  it("two tagged orders with the variant → ambiguous", () => {
    expect(classify(l, search([order(), order({ id: "gid://shopify/Order/501" })])).cls).toBe("ambiguous");
  });
  it("an order missing the Change tag is not ours → unpaid", () => {
    expect(classify(l, search([order({ tags: ["Order #100"] })])).cls).toBe("unpaid");
  });
  it("another customer's order → ambiguous", () => {
    expect(classify(l, search([order({ customer: { id: "gid://shopify/Customer/2" } })])).cls).toBe("ambiguous");
  });
  it("search truncated, or unreadable → ambiguous", () => {
    expect(classify(l, search([], true)).cls).toBe("ambiguous");
    expect(classify(l, reads({ exchangeOrders: { ok: false, error: "x" } })).cls).toBe("ambiguous");
  });
  it("a native exchange line naming the variant → paid (native)", () => {
    const r = ret({ exchangeLineItems: { nodes: [{ id: "gid://shopify/ExchangeLineItem/1", lineItems: [{ variant: { id: V } }] }] } });
    expect(classify(l, { ret: { ok: true, value: r }, exchangeOrders: { ok: true, value: { truncated: false, nodes: [] } } }))
      .toMatchObject({ cls: "paid", evidence: { lane: "native_exchange", exchangeLineItemId: "gid://shopify/ExchangeLineItem/1" } });
  });
  it("two lines of the order exchanging to the same variant → ambiguous", () => {
    const twin = { ...l, productsorderId: 2 };
    expect(classify(l, search([order()]), [l, twin]).cls).toBe("ambiguous");
  });
  it("searches both tags exactly as the pre-S2 code wrote them", () => {
    expect(exchangeOrderSearch("#100")).toBe('tag:"Order #100" AND tag:Change');
  });
  it("judgeLegacyExchangeOrder refuses a wrong quantity", () => {
    const j = judgeLegacyExchangeOrder({ orderNumber: "#100", customerGid: CUSTOMER, newVariantGid: V, quantity: 2 }, order());
    expect(j.ok).toBe(false);
  });
});

describe("null action and grouping", () => {
  it("a line with no action has no lane", () => {
    expect(classify(line({ action: null }), reads())).toMatchObject({ cls: "null-action", lane: null });
  });
  it("groups by Shopify return and tender — explicit ids, nothing else", () => {
    expect(groupKey(line())).toBe("100|gid://shopify/Return/9|refund");
    expect(groupKey(line({ credit: true }))).toBe("100|gid://shopify/Return/9|credit");
    expect(groupKey(line({ returnId: "gid://shopify/Return/10" }))).not.toBe(groupKey(line()));
    // One return id on two orders' rows is never one group.
    expect(groupKey(line({ orderId: "101" }))).not.toBe(groupKey(line()));
  });
});

// Production, 30 Oct: the pre-S1 confirm write keyed rows by VARIANT, so
// #34911's return was stamped on rows of #34700 and #34934 sharing the
// variant. A return_id is identity only for the order Shopify says owns it.
describe("a return stamped across orders (#34911-R1 on #34700, #34911, #34934)", () => {
  const RET = "gid://shopify/Return/37215633734";
  const owner = { id: "gid://shopify/Order/11700404060486", name: "#34911", presentmentCurrencyCode: "EUR", customer: { id: CUSTOMER } };
  const shared = (productsorderId: number, orderId: string, orderNumber: string) =>
    line({ productsorderId, orderId, orderNumber, returnId: RET, action: "CAMBIO", newVariantId: "46943269945670", refunded: true });
  const r181 = shared(181, "11625720185158", "#34700");
  const r189 = shared(189, "11700404060486", "#34911");
  const r184 = shared(184, "11793110000000", "#34934");
  const evidence = { ok: true as const, value: ret({ id: RET, order: owner }) };

  it("only the owning order's row is classified; the others are needs-human naming the owner", () => {
    const all = [r181, r189, r184];
    for (const foreign of [r181, r184]) {
      const c = classify(foreign, { ret: evidence }, all);
      expect(c.cls).toBe("needs-human");
      expect(c.reason).toBe("return id belongs to order #34911 (gid://shopify/Order/11700404060486)");
    }
    expect(classify(r189, { ret: evidence }, all).cls).not.toBe("needs-human");
  });

  it("a NULL-action row on another order's return is needs-human too, not null-action (#35036-R1)", () => {
    const c = classify({ ...r181, action: null }, { ret: evidence });
    expect(c.cls).toBe("needs-human");
  });

  it("R1 records only on a return read and owned: never foreign, unreadable or missing", () => {
    expect(returnOwnedRead(r189, evidence)).toBe(true);
    expect(returnOwnedRead(r181, evidence)).toBe(false);
    expect(returnOwnedRead(r189, { ok: false, error: "timeout" })).toBe(false);
    expect(returnOwnedRead(r189, { ok: true, value: null })).toBe(false);
    expect(new Set([r181, r189, r184].map(groupKey)).size).toBe(3);
  });
});

// Santi, 30 Oct: "Reconcile settled lines only", "You set each amount", and a
// line with no Shopify return listed for a human.
describe("needs-human: a line with no Shopify return", () => {
  it("no return_id, or no return line → needs-human, never ambiguous", () => {
    expect(classify(line({ returnId: null }), { ret: { ok: false, error: "no return on the line" } }).cls).toBe("needs-human");
    expect(classify(line({ returnLineItemId: null }), reads()).cls).toBe("needs-human");
  });
  it("admits no approval", () => {
    const c = classify(line({ returnId: null }), { ret: { ok: false, error: "no return on the line" } });
    expect(approvalBasisOf(line({ returnId: null }), c)).toMatchObject({ ok: false });
  });
});

describe("R1 population: settled lines only", () => {
  const facts = [
    line({ productsorderId: 1, refunded: true }),
    line({ productsorderId: 2, refunded: false }),
    line({ productsorderId: 3, refunded: true }),
    line({ productsorderId: 4, refunded: true }),
  ];
  it("a pending line is never classified; a covered one only when it is a recorded exchange (R2)", () => {
    const got = reconcilePopulation(facts, { covered: new Set([2, 3, 4]), swapCandidates: new Set([4]) });
    expect(got.map((l) => l.productsorderId)).toEqual([1, 4]);
  });
  it("a pending line stays out even if nothing covers it", () => {
    expect(reconcilePopulation(facts, { covered: new Set(), swapCandidates: new Set() }).map((l) => l.productsorderId)).toEqual([1, 3, 4]);
  });
});

describe("R2: the approval a line admits — never an amount", () => {
  const exchangePaid = (unitCents: number) => ({
    productsorderId: 1,
    lane: "exchange" as const,
    cls: "paid" as const,
    reason: "exchange order #500",
    returnStatus: "CLOSED",
    evidence: {
      lane: "exchange" as const,
      orderGid: "gid://shopify/Order/500",
      orderName: "#500",
      lineItemId: "gid://shopify/LineItem/9",
      variantGid: "gid://shopify/ProductVariant/42",
      quantity: 1,
      unitCents,
      currency: "EUR",
    },
  });
  it("unpaid → basis unpaid, capped at the returned value", () => {
    const c = { productsorderId: 1, lane: "refund" as const, cls: "unpaid" as const, reason: "none", returnStatus: "CLOSED" };
    expect(approvalBasisOf(line({ quantity: 2 }), c)).toEqual({ ok: true, basis: "unpaid", capCents: 10000 });
  });
  it("a cheaper replacement → basis swap, capped at returned − replacement (both read, nothing derived)", () => {
    expect(lineValues(line(), exchangePaid(3000))).toEqual({ returnedCents: 5000, replacementCents: 3000 });
    expect(approvalBasisOf(line(), exchangePaid(3000))).toEqual({ ok: true, basis: "swap", capCents: 2000 });
  });
  it("an equal or dearer replacement owes nothing", () => {
    expect(approvalBasisOf(line(), exchangePaid(5000)).ok).toBe(false);
    expect(approvalBasisOf(line(), exchangePaid(6200)).ok).toBe(false);
  });
  it("paid by refund, ambiguous, null-action, native exchange → no approval", () => {
    const base = { productsorderId: 1, lane: "refund" as const, reason: "x", returnStatus: "CLOSED" };
    expect(approvalBasisOf(line(), { ...base, cls: "ambiguous" }).ok).toBe(false);
    expect(approvalBasisOf(line(), { ...base, cls: "null-action" }).ok).toBe(false);
    expect(
      approvalBasisOf(line(), {
        ...base,
        cls: "paid",
        evidence: { lane: "refund", refundId: "gid://shopify/Refund/1", amountCents: 4500, currency: "EUR" },
      }).ok
    ).toBe(false);
    expect(
      approvalBasisOf(line(), {
        ...base,
        cls: "paid",
        evidence: { lane: "native_exchange", returnGid: "r", exchangeLineItemId: "e", variantGid: "v" },
      }).ok
    ).toBe(false);
  });
});

describe("--approve-file", () => {
  it("reads productsorder_id,amount_cents,approved_by", () => {
    expect(parseApprovalFile("productsorder_id,amount_cents,approved_by\n101,2000,santi\n102, 350 ,santi\n")).toEqual({
      ok: true,
      rows: [
        { productsorderId: 101, amountCents: 2000, approvedBy: "santi" },
        { productsorderId: 102, amountCents: 350, approvedBy: "santi" },
      ],
    });
  });
  it.each([
    ["no header", "101,2000,santi"],
    ["missing amount", "productsorder_id,amount_cents,approved_by\n101,,santi"],
    ["zero", "productsorder_id,amount_cents,approved_by\n101,0,santi"],
    ["euros, not cents", "productsorder_id,amount_cents,approved_by\n101,20.00,santi"],
    ["negative", "productsorder_id,amount_cents,approved_by\n101,-5,santi"],
    ["no approver", "productsorder_id,amount_cents,approved_by\n101,2000,"],
    ["twice", "productsorder_id,amount_cents,approved_by\n101,2000,santi\n101,100,santi"],
    ["extra column", "productsorder_id,amount_cents,approved_by\n101,2000,santi,x"],
    ["empty", ""],
  ])("refuses the whole file: %s", (_why, text) => {
    expect(parseApprovalFile(text).ok).toBe(false);
  });
});

describe("needs-human wins over null-action", () => {
  it("a NULL-action line with no Shopify return is needs-human: D3 has no return to decide against", () => {
    expect(classify(line({ action: null, returnId: null }), { ret: { ok: false, error: "no return on the line" } }).cls).toBe("needs-human");
  });
});

// Codex S3 review, 30 Oct: every historical effect, explicit attribution only.
describe("unattributed refunds (Codex #1)", () => {
  const l = line({ isReplacement: true });
  const unmarked = (id: string, status = "SUCCESS") => ({ id, note: "manual", transactions: { nodes: [tx(status)] } });
  const root = (refunds: any[]) =>
    reads({ rootRefunds: { ok: true, value: { orderGid: "gid://shopify/Order/1", presentmentCurrencyCode: "EUR", refunds } } });
  const withLedger = (ledger: Parameters<typeof sharedIdentity>[1]) => (c: LineFacts, r: LineReads) =>
    classifyLine(c, r, sharedIdentity([c], ledger));

  it("a pending unmarked root refund is unattributed too", () => {
    expect(classify(l, root([unmarked("R1", "PENDING")]))).toMatchObject({ cls: "ambiguous", unattributed: ["R1"] });
  });
  it("a zero-money root refund is no payment of anything", () => {
    expect(classify(l, root([{ id: "R1", note: "", transactions: { nodes: [] } }])).cls).toBe("unpaid");
  });
  it("a refund carrying ANOTHER line's marker is that line's, not unattributed", () => {
    const sibling = line({ productsorderId: 2, returnLineItemId: "gid://shopify/ReturnLineItem/6", isReplacement: true });
    const theirs = { id: "R1", note: "[gid://shopify/ReturnLineItem/6]", transactions: { nodes: [tx()] } };
    expect(classify(l, root([theirs]), [l, sibling]).cls).toBe("unpaid");
  });
  it("a refund the ledger recorded for another line is that line's", () => {
    expect(withLedger({ recordedEffects: new Map([["R1", [9]]]) })(l, root([unmarked("R1")])).cls).toBe("unpaid");
  });
  it("a human excludes it → the complete read is unpaid; binds it to this line → paid by it", () => {
    expect(withLedger({ decisions: new Map([["R1", { verdict: "excludes", productsorderId: null }]]) })(l, root([unmarked("R1")])).cls)
      .toBe("unpaid");
    expect(withLedger({ decisions: new Map([["R1", { verdict: "binds", productsorderId: 1 }]]) })(l, root([unmarked("R1")])))
      .toMatchObject({ cls: "paid", evidence: { lane: "root_refund", refundId: "R1" } });
    expect(withLedger({ decisions: new Map([["R1", { verdict: "binds", productsorderId: 2 }]]) })(l, root([unmarked("R1")])).cls)
      .toBe("unpaid");
  });
  it("a money refund on the RETURN naming no line is unattributed for its lines", () => {
    const bare = { id: "R9", refundLineItems: { nodes: [] }, transactions: { nodes: [tx()] } };
    expect(classify(line(), reads({ ret: { ok: true, value: ret({ refunds: { nodes: [bare] } }) } })))
      .toMatchObject({ cls: "ambiguous", unattributed: ["R9"] });
  });
  it("an operator's rejection never clears an unattributed refund; it clears other ambiguity", () => {
    const c = classify(l, root([unmarked("R1")]));
    expect(afterOperatorRejection(c).cls).toBe("ambiguous");
    const other = classify(line({ credit: true }), reads());
    expect(afterOperatorRejection(other).cls).toBe("unpaid");
  });
});

describe("every historical writer, whatever the action (Codex #2)", () => {
  const V = "gid://shopify/ProductVariant/42";
  const card = { id: "gid://shopify/GiftCard/3", initialValue: { amount: "51.75", currencyCode: "EUR" }, customer: { id: CUSTOMER } };
  const noOrders = { exchangeOrders: { ok: true as const, value: { truncated: false, nodes: [] } } };
  it("reads every source a row could have an effect in", () => {
    expect(readsNeeded(line({ action: "CAMBIO", newVariantId: "42", credit: true, giftCardId: "3", isReplacement: true })))
      .toEqual({ rootRefunds: true, giftCard: true, exchangeOrders: true });
    expect(readsNeeded(line())).toEqual({ rootRefunds: false, giftCard: false, exchangeOrders: false });
  });
  it("a credit CAMBIO paid by its stored gift card (the old writer checked credit first) → paid, never unpaid", () => {
    const l = line({ action: "CAMBIO", newVariantId: "42", credit: true, giftCardId: "gid://shopify/GiftCard/3" });
    expect(classify(l, reads({ giftCard: { ok: true, value: card }, ...noOrders }))).toMatchObject({
      cls: "paid",
      lane: "credit",
      evidence: { lane: "credit", giftCardId: "gid://shopify/GiftCard/3" },
    });
  });
  it("a credit CAMBIO with no stored card → ambiguous (no identity), never unpaid", () => {
    expect(classify(line({ action: "CAMBIO", newVariantId: "42", credit: true }), reads(noOrders)).cls).toBe("ambiguous");
  });
  it("a cash CAMBIO with a stored card and no exchange order → ambiguous (conflicting history)", () => {
    const l = line({ action: "CAMBIO", newVariantId: "42", giftCardId: "gid://shopify/GiftCard/3" });
    expect(classify(l, reads({ giftCard: { ok: true, value: card }, ...noOrders })).cls).toBe("ambiguous");
  });
  it("a cash (refund) row whose only effect is a stored gift card → ambiguous (tender mismatch), never paid", () => {
    const l = line({ giftCardId: "gid://shopify/GiftCard/3" });
    expect(classify(l, reads({ giftCard: { ok: true, value: card } })).cls).toBe("ambiguous");
  });
  it("a DEVOLUCIÓN refunded AND delivered an exchange order → ambiguous", () => {
    const l = line({ newVariantId: "42" });
    const order = {
      id: "gid://shopify/Order/500",
      name: "#500",
      tags: ["Change", "Order #100"],
      customer: { id: CUSTOMER },
      lineItems: { nodes: [{ id: "gid://shopify/LineItem/9", quantity: 1, variant: { id: V }, originalUnitPriceSet: { shopMoney: { amount: "30.00", currencyCode: "EUR" } } }] },
    };
    const r = reads({
      ret: { ok: true, value: ret({ refunds: { nodes: [refund("R1", LI, [tx()])] } }) },
      exchangeOrders: { ok: true, value: { truncated: false, nodes: [order] } },
    });
    expect(classify(l, r).cls).toBe("ambiguous");
  });
});

describe("delivery and the difference are separate (Codex #4)", () => {
  const V = "gid://shopify/ProductVariant/42";
  const l = line({ action: "CAMBIO", newVariantId: "42", price: "100.00" });
  const order = {
    id: "gid://shopify/Order/500",
    name: "#500",
    tags: ["Change", "Order #100"],
    customer: { id: CUSTOMER },
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/9", quantity: 1, variant: { id: V }, originalUnitPriceSet: { shopMoney: { amount: "60.00", currencyCode: "EUR" } } }] },
  };
  const delivered = (refunds: any[]) =>
    reads({
      ret: { ok: true, value: ret({ refunds: { nodes: refunds } }) },
      exchangeOrders: { ok: true, value: { truncated: false, nodes: [order] } },
    });
  it("€100 returned, €60 delivered, €40 already refunded on the line → paid, but no swap approval", () => {
    const c = classify(l, delivered([refund("R40", LI, [tx("SUCCESS", "40.00")])]));
    expect(c).toMatchObject({ cls: "paid", evidence: { lane: "exchange" }, moneyEffects: ["R40"] });
    expect(approvalBasisOf(l, c)).toMatchObject({ ok: false });
  });
  it("the same with no refund at all → swap approvable up to €40", () => {
    const c = classify(l, delivered([]));
    expect(approvalBasisOf(l, c)).toEqual({ ok: true, basis: "swap", capCents: 4000 });
  });
  it("an unattributed money refund on the return → ambiguous, not approvable", () => {
    const c = classify(l, delivered([{ id: "R1", refundLineItems: { nodes: [] }, transactions: { nodes: [tx("SUCCESS", "40.00")] } }]));
    expect(c).toMatchObject({ cls: "ambiguous", unattributed: ["R1"] });
    expect(approvalBasisOf(l, c).ok).toBe(false);
  });
});

describe("line totals round once (Codex #7)", () => {
  it("€31.01 over two units, stored 15.505, is 3101 — never 3102", () => {
    const c = { productsorderId: 1, lane: "refund" as const, cls: "unpaid" as const, reason: "none", returnStatus: "CLOSED" };
    expect(lineValues(line({ price: "15.505", quantity: 2 }), c).returnedCents).toBe(3101);
    expect(approvalBasisOf(line({ price: "15.505", quantity: 2 }), c)).toEqual({ ok: true, basis: "unpaid", capCents: 3101 });
  });
});
