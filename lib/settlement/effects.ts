// The ONE money boundary (S2 plan L7).
//
// `import "server-only"`, NOT "use server": every export of a "use server"
// module is a public endpoint, and nothing here may be one. This file holds the
// only copies of the settlement mutations — returnProcess, refundCreate,
// giftCardCreate, orderCreate and draftOrderDelete — all on SHOPIFY_API_VERSION
// and each validated against the 2026-04 schema with validate.mjs.
//
// Its single export is `send(op, dispatchToken)`. The token is the row the
// ledger's dispatch UPDATE returned (lib/settlement/ledger.ts): a caller that
// does not hold a dispatched row for this exact op and attempt cannot send.
// Variables are the op's frozen request, posted verbatim — nothing is built or
// recomputed here.
import "server-only";
import type { DispatchToken } from "./ledger";
import type { Operation } from "./types";
import { shopifyGraphQL, type ShopifyAnswer } from "./shopify";
import {
  GIFT_CARD_EVIDENCE_FIELDS,
  ORDER_EVIDENCE_FIELDS,
  REFUND_EVIDENCE_FIELDS,
  RETURN_EVIDENCE_FIELDS,
} from "./reads";

export const RETURN_PROCESS = `
  mutation SettlementReturnProcess($input: ReturnProcessInput!) {
    returnProcess(input: $input) {
      return {${RETURN_EVIDENCE_FIELDS}
      }
      userErrors { code field message }
    }
  }`;

export const REFUND_CREATE = `
  mutation SettlementRefundCreate($input: RefundInput!, $idempotencyKey: String!) {
    refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
      refund {${REFUND_EVIDENCE_FIELDS}
      }
      userErrors { field message }
    }
  }`;

export const GIFT_CARD_CREATE = `
  mutation SettlementGiftCardCreate($input: GiftCardCreateInput!) {
    giftCardCreate(input: $input) {
      giftCard {${GIFT_CARD_EVIDENCE_FIELDS}
      }
      userErrors { code field message }
    }
  }`;

export const ORDER_CREATE = `
  mutation SettlementOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {${ORDER_EVIDENCE_FIELDS}
      }
      userErrors { field message }
    }
  }`;

export const DRAFT_ORDER_DELETE = `
  mutation SettlementDraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }`;

/** The refundCreate idempotency key: one per (op, attempt). */
export function idempotencyKeyOf(op: Pick<Operation, "id" | "attempt">): string {
  return `${op.id}:${op.attempt}`;
}

export async function send(op: Operation, token: DispatchToken): Promise<ShopifyAnswer> {
  if (
    token.state !== "dispatched" ||
    token.id !== op.id ||
    token.attempt !== op.attempt ||
    !token.owner ||
    token.owner !== op.owner
  ) {
    throw new Error(`send: op ${op.id} attempt ${op.attempt} holds no dispatch for this call`);
  }
  const request = token.request;
  switch (request.kind) {
    case "process_goods":
    case "process_refund":
      return shopifyGraphQL(RETURN_PROCESS, request.variables);
    case "root_refund":
      return shopifyGraphQL(REFUND_CREATE, {
        ...request.variables,
        idempotencyKey: idempotencyKeyOf(token),
      });
    case "gift_card":
      return shopifyGraphQL(GIFT_CARD_CREATE, request.variables);
    case "exchange_order":
      return shopifyGraphQL(ORDER_CREATE, request.variables);
    case "release_hold":
      return shopifyGraphQL(DRAFT_ORDER_DELETE, request.variables);
  }
}
