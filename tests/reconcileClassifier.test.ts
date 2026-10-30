import { describe, expect, it } from "vitest";
import {
  classifyLine,
  groupKey,
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
  it("a refund naming the order in words but not the marker is not evidence → unpaid", () => {
    expect(classify(l, root([{ id: "R1", note: "Return from replacement order #100", transactions: { nodes: [tx()] } }])).cls)
      .toBe("unpaid");
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
    expect(groupKey(line())).toBe("gid://shopify/Return/9|refund");
    expect(groupKey(line({ credit: true }))).toBe("gid://shopify/Return/9|credit");
    expect(groupKey(line({ returnId: "gid://shopify/Return/10" }))).not.toBe(groupKey(line()));
  });
});
