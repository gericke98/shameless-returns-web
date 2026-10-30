// Build what `getSubmission` returns for an ACCEPTED submission covering the
// given productsorder rows — for tests of `confirmSubmission` that mock
// db/submissions. Rows without an action are not part of a submission.
//
// A row's fulfillment line item is what the proposal resolved before checkout:
// taken from `fulfillment` (a FulfillmentShow response, matched by line item
// id, as lib/fulfillmentLines.ts does) unless the row names its own.

type FulfillmentShow = {
  data: { fulfillmentLineItems: { edges: Array<{ node: { id: string; lineItem: { id: string; refundableQuantity?: number | null } } }> } };
};

/** `refundableQuantities`, answered from a FulfillmentShow fixture. */
export function refundableFrom(fulfillment: FulfillmentShow) {
  return async (ids: readonly string[]) => {
    const known = new Map(
      fulfillment.data.fulfillmentLineItems.edges.map((e) => [
        e.node.id,
        e.node.lineItem.refundableQuantity ?? null,
      ])
    );
    return new Map(ids.filter((id) => known.has(id)).map((id) => [id, known.get(id) ?? null]));
  };
}
export type FixtureRow = {
  id: number;
  lineItemId: string;
  action?: string | null;
  quantity?: number;
  new_variant_id?: string | null;
  reason?: string | null;
  notes?: string | null;
  fulfillmentLineItemId?: string | null;
};

export function acceptedSubmission(
  orderId: string,
  rows: FixtureRow[],
  overrides: Partial<{
    tender: "refund" | "credit";
    returnMethod: string;
    returnLegCents: number;
    state: string;
    returnLineItemIds: Record<number, string>;
    fulfillment: FulfillmentShow;
  }> = {}
) {
  const id = "sub-1";
  return {
    submission: {
      id,
      orderId,
      state: overrides.state ?? "accepted",
      tender: overrides.tender ?? "refund",
      returnMethod: overrides.returnMethod ?? "CORREOS",
      currency: "EUR",
      returnLegCents: overrides.returnLegCents ?? 500,
      outboundLegCents: 0,
      chargedFeeCents: overrides.returnLegCents ?? 500,
      returnedValueCents: 0,
      replacementValueCents: 0,
      netCents: 0,
      stripeChargeCents: 0,
      waivedCents: 0,
      owedCents: 0,
      residualCents: 0,
      stripeSessionId: null,
      stripePaymentIntent: null,
      createdAt: new Date(),
      acceptedAt: new Date(),
    },
    lines: rows
      .filter((row) => row.action)
      .map((row) => ({
        submissionId: id,
        productsorderId: row.id,
        shopifyLineItemId: row.lineItemId,
        quantity: row.quantity ?? 1,
        action: String(row.action),
        newVariantId: row.action === "CAMBIO" ? row.new_variant_id ?? null : null,
        reason: row.reason ?? null,
        notes: row.notes ?? null,
        returnedCents: 0,
        replacementCents: 0,
        payCents: 0,
        stripeFundedCents: 0,
        fulfillmentLineItemId:
          row.fulfillmentLineItemId ??
          overrides.fulfillment?.data.fulfillmentLineItems.edges.find(
            (e) => e.node.lineItem.id === `gid://shopify/LineItem/${row.lineItemId}`
          )?.node.id ??
          null,
        returnLineItemId: overrides.returnLineItemIds?.[row.id] ?? null,
      })),
  };
}
