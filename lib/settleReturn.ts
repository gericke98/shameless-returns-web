/**
 * Settling one returned garment: gift card, exchange, or refund.
 *
 * Lifted out of `validateReturn` so the dashboard button and the auto-approve
 * cron run the SAME payout. Two callers, one implementation — the €5 return-leg
 * deduction and the ×1.15 credit multiplier already live in four places across
 * this codebase, and must not gain a fifth by being copied into a cron.
 *
 * Deliberately unauthenticated and deliberately not cache-invalidating: both are
 * the caller's job, because the two callers need different answers. Never
 * import this from a client component.
 */

import db from "@/db/drizzle";
import {
  closeReturn,
  createOrder,
  createRefund,
  createStoreCreditRefund,
  noteStoreCreditOnOrder,
  getOrderById,
  getOrderByIdFresh,
  getOrderRefundNotes,
  getOrderTotal,
  processGiftCardReturn,
  refundOnOrder,
} from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getFeeTable } from "@/db/fees";
import { resolveZone } from "@/lib/zones";
import { centsToEuros, feesForCountry, feesForWeight } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import { releaseExchangeReservation } from "@/actions/exchangeReservation";
import { alertOps } from "@/actions/opsAlert";
import { rootOrderIdOf } from "@/actions/replacementOrder";
import { hasUnmarkedRefundFor, wasProductSwap } from "@/lib/replacementOrigin";

export type SettleOutcome =
  | {
      settled: true;
      lane: "credit" | "exchange" | "refund";
      /** The `productsorder` row ids this call actually flipped to refunded.
       *  Usually the one line asked for — but the exchange lane settles EVERY
       *  pending exchange line of the order in one shot, and a caller looping
       *  over lines has to know that or it will report the siblings it just
       *  paid as refusals. */
      lineIds: string[];
    }
  | { settled: false; reason: string };

/**
 * Did the customer ship this return with their own courier?
 *
 * Settlement is the SECOND place the return leg is collected — `createStripeUrl`
 * is the first — and the two have to agree. A self-booked return is advertised
 * as free and charged nothing up front, so deducting the leg here would take it
 * from the refund instead, silently, after the customer was shown a larger
 * number. Read from the row, never from the caller's object: `validateReturn`
 * already refuses to trust it for anything that decides money.
 */
const isSelfBooked = (row: { returnMethod?: string | null } | null | undefined) =>
  row?.returnMethod === "SELF";

/**
 * Tell ops when a returned replacement may have cost the customer more than
 * the original line price we pay back: a swap to a DIFFERENT product can carry
 * a Stripe top-up, and that money is on Stripe, not on the Shopify order.
 * Informational only — never blocks settlement. It runs AFTER money has moved
 * and the row is marked, so it must never throw: a throw here would surface as
 * a failed settlement for a customer who was in fact paid.
 */
/** Appended to every replacement-lane alert: the rule that keeps #312061 from recurring. */
const NEVER_BY_HAND =
  "Returns from replacement orders must be settled through the dashboard — never refund them by hand on the original order.";

async function alertPossibleTopUp(line: any, order: any, lane: string) {
  try {
    if (!order?.exchangeOf) return;
    const original = await getOrderByIdFresh(String(order.exchangeOf));
    const pi = (original as any)?.stripePaymentIntent;
    if (!pi) return;
    if (!wasProductSwap((original as any)?.products ?? [], String(line.variant_id), String(line.productId))) return;
    await alertOps(
      `[returns] POSSIBLE TOP-UP OWED — ${order.orderNumber}`,
      `${order.orderNumber} is a replacement for ${original?.orderNumber}. The customer swapped to a different product and paid through Stripe (${pi}).\n` +
        `The ${lane} paid only the original line price (${line.price} EUR). Check whether part of ${pi} was a top-up for this garment and refund it from Stripe if so.`
    );
  } catch (error) {
    console.error(
      `alertPossibleTopUp: could not check order ${order?.id} (line ${line?.id}) for a top-up`,
      error
    );
  }
}

export async function settleReturnLine(product: any, order: any): Promise<SettleOutcome> {
  // Reload the line from the database instead of trusting what the caller sent.
  // `product` arrives as `any` from the dashboard, and two of its fields decide
  // money: `credit` picks gift card over refund, and `price` IS the gift-card
  // value. An admin session should not also be permission to name that number.
  // The caller still supplies the identifiers — those are looked up, not obeyed.
  const trustedLine = await db.query.productsOrder.findFirst({
    where: and(
      eq(productsOrder.orderId, String(order?.id ?? "")),
      eq(productsOrder.variant_id, String(product?.variant_id ?? ""))
    ),
  });
  if (!trustedLine) {
    console.error(
      `settleReturnLine: no line for order=${order?.id} variant=${product?.variant_id}`
    );
    return { settled: false, reason: "no-such-line" };
  }
  if (trustedLine.refunded) {
    // Already settled. Without this, replaying the same call mints a second
    // gift card for the same return.
    console.error(`settleReturnLine: line ${trustedLine.id} is already refunded`);
    return { settled: false, reason: "already-refunded" };
  }

  // For debugging purposes
  let result;
  let result2;
  // Aqui igual puedo poner si el estado es distinto de preregistrado --> Meter aqui modales para avisar ui
  // En el caso de ser una gift card, se crea una gift card y no reembolso
  if (trustedLine.credit) {
    // Extraigo la info completa del pedido para saber el customer id
    const totalOrder = await getOrderTotal(order.id);
    const customerId = totalOrder.customer.id;

    // Extraigo el valor del gift card (En este caso siempre será return)
    const feeTable = await getFeeTable();
    const dbOrder = await getOrderById(String(order?.id ?? ""));
    const orderFees = feesForCountry(
      feeTable,
      // From the database, not the caller's object: a lower fee here means a
      // larger gift card.
      resolveZone(dbOrder?.shippingCountry, dbOrder?.shippingZip)
    );
    // The band is chosen by the weight of the whole return parcel, not of
    // this one line — the customer ships one box, and the carrier prices
    // that box. A missing basket falls back to the lightest band, which
    // deducts the least and so favours the customer.
    const loaded = await loadBasket(String(order?.id ?? ""));
    const fees = feesForWeight(orderFees, loaded?.basket.grams ?? 0);
    // A self-booked return paid its own courier. `createStripeUrl` charged
    // nothing for the return leg and the portal showed the undocked figure,
    // so deducting it here would dock the customer for shipping we never did
    // ON TOP of the postage they bought themselves — less money than the
    // number they were shown.
    const returnFeeCents = isSelfBooked(dbOrder) ? 0 : fees.returnFeeCents;
    const giftCardValue =
      (Number(trustedLine.price) - centsToEuros(returnFeeCents)) * 1.15;
    const resultGiftCard = await processGiftCardReturn(
      customerId,
      giftCardValue,
      trustedLine.variant_id,
      String(order?.id ?? "")
    );
    if (resultGiftCard.success) {
      // Tell Shopify the goods came back. The gift card above pays the
      // customer; this is the other half, and without it the order reads
      // PAID at 0.00 refunded for good — the money lane has always done
      // this via `createRefund` and the credit lane never did.
      //
      // Read the line item from the row, not from `product`: the caller's
      // object is untrusted everywhere else in this function for exactly
      // the reason it is untrusted here — it names what Shopify refunds.
      const refundRecord = await createStoreCreditRefund(
        String(trustedLine.return_id ?? ""),
        String(trustedLine.return_line_item_id ?? "")
      );
      // Say so on the order too. The refund above is invisible on the order
      // page — it carries no money, so the header still reads PAID — and a
      // human looking at a paid order with a return against it has nothing
      // telling them the customer was already paid in credit.
      //
      // Best effort: the customer has their card either way, and a missing
      // sentence is not worth failing a settlement over.
      await noteStoreCreditOnOrder(
        String(order?.id ?? ""),
        giftCardValue,
        String(resultGiftCard.data?.id ?? "")
      );
      if (!refundRecord.success) {
        // Carry on rather than bail, and the asymmetry is the reason.
        //
        // By this line the customer HAS been paid — the card is minted and
        // Shopify has emailed it. Bailing would leave `refunded` unset, and
        // the guard at the top of this function is exactly that flag, so the
        // next click on the row would mint a SECOND card for one garment.
        // A revenue figure a human can correct in the admin beats paying
        // twice, so the alert carries the ids needed to fix it by hand.
        await alertOps(
          `[returns] STORE-CREDIT REFUND NOT RECORDED — order ${order?.id}`,
          [
            `Gift card ${resultGiftCard.data?.id ?? "(id unknown)"} was issued to the customer, so they HAVE been paid.`,
            `What failed is the Shopify refund record, so order ${order?.id} still reads PAID with 0.00 refunded and the garment still counts as revenue.`,
            `Return: ${product.return_id}`,
            `Return line item: ${trustedLine.return_line_item_id}`,
            `Fix by refunding the return in the Shopify admin WITHOUT sending money — the customer already has the credit.`,
            `Error: ${JSON.stringify(refundRecord.errors ?? refundRecord.error)}`,
          ].join("\n")
        );
      }
      // Cierro el return
      result2 = await closeReturn(String(trustedLine.return_id ?? ""));
      // By ROW ID, not by variant. `productsorder` is keyed per line item, so
      // an order carrying two rows for the same variant would otherwise have
      // BOTH flipped by the one gift card issued above — the second garment
      // silently paid for with nothing.
      await db
        .update(productsOrder)
        .set({
          refunded: true,
        })
        .where(eq(productsOrder.id, trustedLine.id));
      await alertPossibleTopUp(trustedLine, dbOrder, "store credit");
      return { settled: true, lane: "credit", lineIds: [String(trustedLine.id)] };
    }
    return { settled: false, reason: "gift-card-failed" };
  } else if (product.action === "CAMBIO") {
    // Every exchanged garment on this order ships in ONE parcel.
    //
    // This used to create a Shopify order per dashboard row, so an order with
    // two exchanges produced two orders — two parcels to the same address, two
    // shipping charges, two deliveries for the customer to wait on. The rows
    // are separate in the UI but the shipment is not, so the whole exchange is
    // settled together and clicking the sibling row afterwards is a no-op
    // (its `refunded` flag is already set).
    const exchangeLines = await db.query.productsOrder.findMany({
      where: and(
        eq(productsOrder.orderId, String(order?.id ?? "")),
        eq(productsOrder.action, "CAMBIO"),
        eq(productsOrder.confirmed, true)
      ),
    });
    const pending = exchangeLines.filter(
      (line) => !line.refunded && line.new_variant_id
    );
    if (pending.length === 0) {
      console.error(
        `settleReturnLine: no pending exchange lines for order ${order?.id}`
      );
      return { settled: false, reason: "no-pending-exchange-lines" };
    }

    // Release the hold FIRST. The draft order and the real one would
    // otherwise both claim the same unit, and DECREMENT_OBEYING_POLICY would
    // refuse to sell the last garment in stock to the very customer it is
    // being held for.
    await releaseExchangeReservation(String(order?.id ?? ""));

    result = await createOrder(order, pending);
    if (result?.success) {
      await db
        .update(productsOrder)
        .set({ refunded: true })
        .where(
          and(
            eq(productsOrder.orderId, String(order?.id ?? "")),
            inArray(
              productsOrder.id,
              pending.map((line) => line.id)
            )
          )
        );
      // Close each distinct return once, not once per line. Batched returns
      // share a return_id, so closing per line would call returnClose N times
      // on the same return.
      const returnIds = Array.from(
        new Set(pending.map((line) => line.return_id).filter(Boolean))
      );
      for (const returnId of returnIds) {
        result2 = await closeReturn(returnId as string);
      }
      return {
        settled: true,
        lane: "exchange",
        lineIds: pending.map((line) => String(line.id)),
      };
    }
    return { settled: false, reason: "exchange-order-failed" };
  } else {
    // Refuse BEFORE Shopify rather than after.
    //
    // `createReturn` stores null when the order carries no settled payment to
    // refund against, and `String(null ?? "")` is `""` — an empty parentId that
    // Shopify rejects with a userError buried in the money path. Refusing here
    // names the real problem instead, and the caller alerts on it.
    const refundTransactionId = String(trustedLine.transaction_id ?? "").trim();
    if (!refundTransactionId) {
      console.error(
        `settleReturnLine: line ${trustedLine.id} has no refundable transaction`
      );
      return { settled: false, reason: "no-refund-transaction" };
    }
    if (product.return_id && product.return_line_item_id) {
      // Same rule as the gift-card branch above: a self-booked return's
      // return leg is zero at settlement, because it was zero at checkout.
      const settlementOrder = await getOrderById(String(order?.id ?? ""));
      // Every value below comes from the reloaded row, not from `product`.
      // The caller's object is untrusted for money everywhere else in this
      // function — `price` sets the amount and the three ids name WHAT and
      // WHICH TRANSACTION Shopify refunds, which is the same authority.
      // Same €5 rule, same self-booked zeroing; only the source changed.
      let amountToRefund =
        Number(trustedLine.price) - (isSelfBooked(settlementOrder) ? 0 : 5);
      if (settlementOrder?.exchangeOf) {
        // A replacement order's payment is a €0.01 placeholder: the money goes
        // back on the ROOT order, the goods come back on this one. Order
        // matters: refuse → CLAIM the row → money → book the goods.
        //
        // Why claim before paying: two settlements of the same line can overlap
        // (a dashboard double-submit, or a click while the cron runs). Both
        // would pass the plain `refunded` read above, and both would pass
        // refundOnOrder's note check, which is read-then-write. The ordinary
        // lane has a Shopify backstop (returnRefund rejects a second refund of
        // the same return line item); a root-order refundCreate does NOT — it
        // is capped only by the remaining refundable amount, so a second
        // payout would succeed. The atomic claim lets exactly one caller in.
        //
        // 0. Find the root BEFORE any money moves. The walk throws on an
        // exchange_of cycle; nothing has been paid yet, so refusing is safe.
        let rootId: string;
        try {
          rootId = await rootOrderIdOf(String(settlementOrder.id));
        } catch (error) {
          console.error(
            `settleReturnLine: cannot resolve the root order of replacement ${settlementOrder.id} (${settlementOrder.orderNumber}) — nothing refunded`,
            error
          );
          return { settled: false, reason: "refund-failed" };
        }
        const marker = String(trustedLine.return_line_item_id ?? "").trim();
        if (!marker) {
          // The marker is what makes a replayed refund a no-op. Without it the
          // next cron run could pay again, so refuse while nothing has moved.
          console.error(
            `settleReturnLine: line ${trustedLine.id} on replacement ${settlementOrder.orderNumber} has no return line item — nothing refunded`
          );
          return { settled: false, reason: "refund-failed" };
        }
        // 0b. Was the customer already paid BY HAND on the root? A manual refund
        // there is invisible to everything else: the auto-approve gate reads
        // the Return on the REPLACEMENT (still OPEN), `refunded` is still NULL,
        // and refundOnOrder only recognises its own bracketed marker — so it
        // would pay a second time. Checked before the claim and before any
        // money; an unreadable root refuses rather than proceeding blind.
        const rootNotes = await getOrderRefundNotes(rootId);
        if (!rootNotes.success) {
          console.error(
            `settleReturnLine: cannot read refunds on root ${rootId} for replacement ${settlementOrder.orderNumber} — nothing refunded`
          );
          return { settled: false, reason: "refund-failed" };
        }
        if (hasUnmarkedRefundFor(rootNotes.notes, String(settlementOrder.orderNumber ?? ""), marker)) {
          try {
            await alertOps(
              `[returns] REPLACEMENT RETURN MAY ALREADY BE PAID — ${settlementOrder.orderNumber}`,
              [
                `Root order ${rootId} already has a refund whose note mentions ${settlementOrder.orderNumber}, but it was not made by settlement (no [${marker}] marker).`,
                `Verify by hand whether the customer was already paid for productsorder row ${trustedLine.id}. If they were, mark the line refunded; do NOT settle it again.`,
                `Nothing was claimed and no money moved.`,
                NEVER_BY_HAND,
              ].join("\n")
            );
          } catch (error) {
            console.error(`settleReturnLine: unmarked-refund alert failed for line ${trustedLine.id}`, error);
          }
          return { settled: false, reason: "root-has-unmarked-refund" };
        }
        // 1. Claim the row atomically. `refunded` is NULL on most live rows,
        // not false, so the condition must accept NULL.
        const claimed = await db
          .update(productsOrder)
          .set({ refunded: true })
          .where(
            and(
              eq(productsOrder.id, trustedLine.id),
              or(isNull(productsOrder.refunded), eq(productsOrder.refunded, false))
            )
          )
          .returning({ id: productsOrder.id });
        if (claimed.length === 0) {
          console.error(
            `settleReturnLine: line ${trustedLine.id} was claimed by a concurrent settlement — not paying`
          );
          return { settled: false, reason: "already-refunded" };
        }
        // 2. Money, also idempotent on the return line item id (a retry after
        // a crash between Shopify accepting and us returning pays nothing).
        const money = await refundOnOrder(
          rootId,
          refundTransactionId,
          amountToRefund,
          marker,
          `Return from replacement order ${settlementOrder.orderNumber}`
        );
        if (!money.success) {
          // Nothing was paid: release the claim so a later run can retry. If
          // the release itself fails the row stays claimed — marked refunded
          // with the customer NOT paid, which no later run will touch — so it
          // gets its own reason and alert and a human clears it.
          try {
            await db
              .update(productsOrder)
              .set({ refunded: false })
              .where(eq(productsOrder.id, trustedLine.id));
          } catch (error) {
            console.error(
              `settleReturnLine: root refund failed for line ${trustedLine.id} and releasing its claim failed too — row stays marked refunded, customer NOT paid`,
              error
            );
            try {
              await alertOps(
                `[returns] CLAIM STUCK — ${settlementOrder.orderNumber}`,
                [
                  `The root refund for ${settlementOrder.orderNumber} failed, and releasing the settlement claim failed too.`,
                  `Row marked refunded but customer NOT paid — clear \`refunded\` on productsorder row ${trustedLine.id} by hand so the next run retries.`,
                  NEVER_BY_HAND,
                ].join("\n")
              );
            } catch (alertError) {
              console.error(`settleReturnLine: claim-stuck alert failed for line ${trustedLine.id}`, alertError);
            }
            return { settled: false, reason: "claim-stuck" };
          }
          return { settled: false, reason: "refund-failed" };
        }
        // 3. Paid. The row was already marked by the claim, so no later run
        // can pay again, whatever fails below.
        // 4. Goods. Accounting only; a failure here is cleanup, not a debt.
        // Caught as well as checked: a THROW from here must not escape as a
        // failed settlement either — the customer has been paid.
        let bookingFailure: unknown = null;
        try {
          const booked = await createStoreCreditRefund(
            String(trustedLine.return_id ?? ""),
            marker
          );
          const closedReturn = booked.success
            ? await closeReturn(String(trustedLine.return_id ?? ""))
            : booked;
          if (!booked.success || !closedReturn.success) {
            bookingFailure = (closedReturn as any).errors ?? (closedReturn as any).error ?? "unknown";
          }
        } catch (error) {
          bookingFailure = error instanceof Error ? error.message : error;
        }
        if (bookingFailure !== null) {
          try {
            await alertOps(
              `[returns] REPLACEMENT RETURN PAID, NOT BOOKED — ${settlementOrder.orderNumber}`,
              `The customer WAS refunded ${amountToRefund.toFixed(2)} EUR on the root order. Booking the goods back on ${settlementOrder.orderNumber} (${trustedLine.return_id}) failed — record the return and close it by hand. Do NOT refund again.\n` +
                `Error: ${JSON.stringify(bookingFailure)}\n` +
                NEVER_BY_HAND
            );
          } catch (error) {
            console.error(
              `settleReturnLine: line ${trustedLine.id} paid but not booked, and the alert failed`,
              error
            );
          }
        }
        await alertPossibleTopUp(trustedLine, settlementOrder, "refund");
        return { settled: true, lane: "refund", lineIds: [String(trustedLine.id)] };
      }
      result = await createRefund(
        String(trustedLine.return_id ?? ""),
        String(trustedLine.return_line_item_id ?? ""),
        refundTransactionId,
        amountToRefund
      );
    }
    if (result?.success) {
      // Cierro el return
      result2 = await closeReturn(String(trustedLine.return_id ?? ""));
      // By ROW ID — see the credit lane above. One refund was issued, so
      // exactly one row may be marked paid.
      await db
        .update(productsOrder)
        .set({
          refunded: true,
        })
        .where(eq(productsOrder.id, trustedLine.id));
      return { settled: true, lane: "refund", lineIds: [String(trustedLine.id)] };
    }
    return { settled: false, reason: "refund-failed" };
  }
}
