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
  getOrderTotal,
  processGiftCardReturn,
} from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getFeeTable } from "@/db/fees";
import { resolveZone } from "@/lib/zones";
import { centsToEuros, feesForCountry, feesForWeight } from "@/lib/fees";
import { loadBasket } from "@/lib/loadBasket";
import { releaseExchangeReservation } from "@/actions/exchangeReservation";
import { alertOps } from "@/actions/opsAlert";

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
      result = await createRefund(
        String(trustedLine.return_id ?? ""),
        String(trustedLine.return_line_item_id ?? ""),
        String(trustedLine.transaction_id ?? ""),
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
