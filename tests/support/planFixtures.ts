// Builders for lib/settlement/plan.ts inputs: one submission, its lines, the
// Shopify return they sit on, and the paying order. Defaults describe one
// ordinary, accepted, refund-tender return of one garment.
import type { PlanInput, ReturnFacts } from "@/lib/settlement/plan";
import type { SubmissionForAdmission, SubmissionLineRow } from "@/lib/settlement/ledger";

export const SUB = "5ub00000-0000-4000-8000-000000000001";
export const RETURN = "gid://shopify/Return/1";
export const ORDER_GID = "gid://shopify/Order/100";
export const TX = "gid://shopify/OrderTransaction/7";

export const submission = (over: Partial<SubmissionForAdmission> = {}): SubmissionForAdmission => ({
  id: SUB,
  orderId: "100",
  state: "accepted",
  tender: "refund",
  currency: "EUR",
  residualCents: 0,
  holder: null,
  admissionSeq: 0,
  provenance: "agreed",
  ...over,
});

export const line = (po: number, over: Partial<SubmissionLineRow> = {}): SubmissionLineRow => ({
  productsorderId: po,
  quantity: 1,
  action: "DEVOLUCIÓN",
  newVariantId: null,
  payCents: 4500,
  stripeFundedCents: 0,
  returnedCents: 5000,
  fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${po}`,
  returnLineItemId: `gid://shopify/ReturnLineItem/${po}`,
  reverseFulfillmentLineItemId: null,
  settledAt: null,
  ...over,
});

export function returnFacts(lines: SubmissionLineRow[], over: Partial<ReturnFacts> = {}): ReturnFacts {
  return {
    returnGid: RETURN,
    status: "OPEN",
    hasExchangeLineItems: false,
    returnLines: new Map(lines.map((l) => [String(l.returnLineItemId), { quantity: l.quantity }])),
    reverseByFulfillment: new Map(
      lines.map((l) => [
        String(l.fulfillmentLineItemId),
        { id: `gid://shopify/ReverseFulfillmentOrderLineItem/${l.productsorderId}`, totalQuantity: l.quantity },
      ])
    ),
    orderGid: ORDER_GID,
    customerGid: "gid://shopify/Customer/9",
    presentment: null,
    ...over,
  };
}

export const ORDER = {
  id: "100",
  orderNumber: "#311000",
  email: "c@example.com",
  shippingName: "Ana",
  shippingAddress1: "Calle 1",
  shippingAddress2: null,
  shippingZip: "28001",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "Spain",
  shippingPhone: "600000000",
};

/** A PlanInput admitting `admit` (default: every line). */
export function planInput(
  lines: SubmissionLineRow[],
  over: Partial<PlanInput> = {}
): PlanInput {
  let n = 0;
  let c = 0;
  return {
    submission: submission(),
    lines,
    admit: lines.map((l) => l.productsorderId),
    existing: [],
    rows: new Map(lines.map((l) => [l.productsorderId, { returnId: RETURN, transactionId: TX }])),
    returns: new Map([[RETURN, returnFacts(lines)]]),
    isReplacement: false,
    paying: {
      orderGid: ORDER_GID,
      presentment: null,
      gateways: new Map([[TX, "shopify_payments"]]),
      transactionId: TX,
    },
    reservation: null,
    order: ORDER,
    newId: () => `op-${++n}`,
    newGiftCardCode: () => `CODE${String(++c).padStart(12, "0")}`,
    ...over,
  };
}
