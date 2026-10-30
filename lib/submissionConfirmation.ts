// Confirming a submission and undoing one: the steps between "the customer
// agreed and, if they owed anything, paid" and "a Shopify return exists".
//
// NOT a "use server" module. Every export of one is a callable endpoint, and
// neither of these may be: anyone who knew an order id could revert it and
// release its stock hold. They are reached only through the gated portal
// action (actions/return.ts) and the signature-verified Stripe webhook.
import db from "@/db/drizzle";
import { createReturn, getOrderById, getOrderTotal } from "@/db/queries";
import { productsOrder } from "@/db/schema";
import { getSubmission, recordConfirmation } from "@/db/submissions";
import { centsToEuros } from "@/lib/fees";
import { refundableQuantities } from "@/lib/fulfillmentLines";
import {
  buildReturnInput,
  matchReturnLineItems,
  presentmentRateFromOrder,
  type ReturnableLine,
} from "@/lib/returnPayload";
import {
  releaseExchangeReservation,
  reserveExchangeStock,
} from "@/actions/exchangeReservation";
import { refundSourceFor } from "@/actions/replacementOrder";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * NOT session-gated, deliberately.
 *
 * Reached from two callers: `returnFunction` (a customer with a portal session)
 * and the Stripe webhook (`app/api/webhooks/stripe/route.ts`), which is an
 * inbound request from Stripe with NO cookies, authenticated by signature
 * verification instead.
 *
 * Adding a portal-session check here would break every PAID return: the payment
 * would succeed and the return would never be created. The gate belongs on the
 * customer entry points — see docs/superpowers/specs/2026-07-27-portal-session-design.md
 */
export async function revertFinalOrder(id: string) {
  {
    // Deliberately NOT `getOrderProductsById` — that is wrapped in React
    // `cache()`, so a revert following a create in the SAME request would read
    // the rows as they were before the create and decide on stale data. The
    // guard below is only meaningful against what is actually in the table now.
    const products = await db.query.productsOrder.findMany({
      where: eq(productsOrder.orderId, id),
    });
    const refusals = await Promise.all(
      products.map(async (product) => {
        // A row carrying a `return_id` has a REAL Shopify return behind it, and
        // reverting cannot delete that return — it only blanks our copy of it,
        // which hides a live return from the dashboard (`getReturns` filters on
        // `confirmed`) and leaves the customer with nothing.
        //
        // Order #310957: the customer submitted, the return was created, the
        // request then timed out; she retried, `returnCreate` rejected the
        // second attempt ("Return line item has an invalid quantity" — the units
        // were already on R1), and the catch-all revert wiped the state of the
        // FIRST, successful return. Same reasoning as the post-booking failures
        // in createInternationalReturn / createShippingLabel: once the external
        // thing exists, reverting our side only makes the records lie.
        if (product.return_id) {
          console.error(
            `Order ${id}: refusing to revert variant ${product.variant_id} — it already carries Shopify return ${product.return_id}. Needs manual review, not a revert.`
          );
          return true;
        }
        if (product.confirmed) {
          // By row id: two rows can share a variant, and only this one is
          // being reverted.
          await db
            .update(productsOrder)
            .set({ confirmed: false, return_id: null })
            .where(eq(productsOrder.id, product.id));
        }
        return false;
      })
    );
    // The return is being undone, so the stock hold must go with it —
    // otherwise the replacement garments stay frozen for a return that no
    // longer exists.
    //
    // UNLESS the revert was refused. A refused line carries a live Shopify
    // return, and the hold belongs to THAT return — releasing it frees the
    // replacement garment for a return that very much still exists. Order
    // #311329 (2026-08-21): a paid Netherlands exchange whose Amphora booking
    // reported 501 after the collection had in fact been committed. The line
    // refused correctly, the return, the collection and the customer's
    // confirmation email all survived — and this call, one level outside the
    // loop's result, quietly deleted the draft order holding their Medium.
    if (!refusals.some(Boolean)) {
      await releaseExchangeReservation(id);
    }
    revalidatePath("/", "layout");
  }
}

/**
 * Confirm an ACCEPTED submission: create its Shopify return and mark its rows,
 * from the agreement — never from the live rows.
 *
 * The rows can change between checkout and payment (another tab, a fee-table
 * edit); what was paid for is the submission, so that is what is returned,
 * reserved and later settled. Lines are identified by `productsorder.id` and
 * the Shopify line item id, never by variant: two rows can share a variant.
 *
 * NOT session-gated, for the reason given on `revertFinalOrder` above: the
 * Stripe webhook calls it with no cookies. The gate is that only an accepted
 * submission is confirmed, and only the free path and a verified payment
 * accept one (db/submissions.ts).
 */
export async function confirmSubmission(submissionId: string) {
  const loaded = await getSubmission(submissionId);
  if (!loaded || loaded.submission.state !== "accepted") {
    throw new Error(
      `confirmSubmission: submission ${submissionId} is ${loaded?.submission.state ?? "missing"}, not accepted`
    );
  }
  const { submission, lines: agreed } = loaded;
  const id = submission.orderId;

  // Idempotency. Reachable twice for one parcel: the Stripe webhook is
  // redelivered, or the free path is retried. Shopify would reject the second
  // `returnCreate` — the units are already on the first return — and the
  // caller's catch-all revert used to undo the first, successful return.
  if (agreed.some((line) => line.returnLineItemId)) {
    console.warn(
      `Order ${id}: submission ${submissionId} already has its Shopify return — skipping creation (redelivery or retry).`
    );
    return;
  }

  const totalOrder = await getOrderTotal(id);
  // Fresh, not `getOrderProductsById`: that is request-scoped `cache()`d.
  const rows = await db.query.productsOrder.findMany({
    where: eq(productsOrder.orderId, id),
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));

  // A row already carrying a return is on a live Shopify return from an
  // earlier submission — asking Shopify for it again fails the whole mutation.
  // Same class of bug as #310756, which was billed the return fee twice.
  const alreadyReturned = agreed
    .map((line) => rowById.get(line.productsorderId))
    .find((row) => row?.return_id);
  if (alreadyReturned) {
    console.warn(
      `Order ${id}: row ${alreadyReturned.id} already carries Shopify return ${alreadyReturned.return_id} — skipping creation.`
    );
    return;
  }

  const dbOrder = await getOrderById(id);
  // The leg declared to Shopify is the one agreed at checkout: zero for a
  // self-booked return, which pays its own courier.
  const returnFeeEuros =
    submission.returnMethod === "SELF" ? 0 : centsToEuros(submission.returnLegCents);

  // The fulfillment line items are the ones agreed at checkout. Only how
  // many of each Shopify will still take back is read live: that is Shopify's
  // state, not the line's identity.
  const refundable = await refundableQuantities(
    agreed.map((line) => line.fulfillmentLineItemId ?? "").filter(Boolean)
  );
  const lines: ReturnableLine[] = agreed.map((line) => {
    const fulfillmentLineItemId = line.fulfillmentLineItemId;
    if (!fulfillmentLineItemId || !refundable.has(fulfillmentLineItemId)) {
      // A paid line cannot quietly drop out of its return. Throwing before
      // returnCreate leaves nothing half-made: the caller reverts and alerts.
      throw new Error(
        `Order ${id}: row ${line.productsorderId} was agreed with fulfillment line item ` +
          `${fulfillmentLineItemId ?? "(none)"}, which Shopify no longer has`
      );
    }
    return {
      productsorderId: line.productsorderId,
      variant_id: String(rowById.get(line.productsorderId)?.variant_id ?? ""),
      fulfillmentLineItemId,
      quantity: line.quantity,
      refundableQuantity: refundable.get(fulfillmentLineItemId) ?? null,
      action: line.action,
      reason: line.reason ?? undefined,
      notes: line.notes ?? undefined,
      new_variant_id: line.newVariantId ?? undefined,
    };
  });
  if (lines.length === 0) {
    console.error(`No returnable lines for order ${id} — nothing to create`);
    return;
  }

  // ONE return for the whole parcel.
  //
  // This used to be a Promise.all over the products, calling returnCreate once
  // each: order #310756 ended up with returns R1 and R2 for a single box, each
  // carrying the full 5 EUR shipping fee — 10 EUR for one parcel — and the
  // dashboard then minted one exchange order per return.
  //
  // NATIVE_EXCHANGES is off by default. With it off this is today's behaviour
  // minus the duplication; with it on the return also declares what the
  // customer is exchanging FOR, which is what links the replacement to the
  // return in Shopify. See docs — it changes where the warehouse sees the
  // replacement, so it stays dark until Amphora confirms they act on it.
  // The fee is priced in EUR but has to be declared in the currency the
  // customer was shown, taken from the order's own money set. See
  // `presentmentRateFromOrder` — a hardcoded EUR here cost order #310741 its
  // whole return.
  const returnInput = buildReturnInput(String(totalOrder.id), lines, returnFeeEuros, {
    includeExchangeItems: process.env.NATIVE_EXCHANGES === "true",
    presentment: presentmentRateFromOrder(totalOrder.total_price_set),
  });

  // `buildReturnInput` drops a line Shopify will no longer take back, so an
  // order whose every line has already been refunded arrives here with an
  // EMPTY payload. Asking Shopify to create a return with no line items
  // spends a round trip to be told what we can already see.
  if (returnInput.returnLineItems.length === 0) {
    console.error(
      `Order ${id}: every line is already refunded in Shopify — nothing to return`
    );
    return;
  }

  const result = await createReturn(returnInput);

  if (!result.success) {
    throw new Error(
      `returnCreate failed for order ${id}: ${JSON.stringify(
        (result as any).errors ?? (result as any).error
      )}`
    );
  }

  // On one of our replacement orders the return's own transaction is the €0.01
  // placeholder; the money is on the root order. See actions/replacementOrder.ts.
  //
  // Guarded HERE, not inside `refundSourceFor`: the Shopify return above
  // already exists, and the return line item ids — written below — are what
  // the idempotency guard at the top of this function checks on a retry.
  // Letting a `resolveRootOrderId` cycle or a failed `getOrderByIdFresh` throw
  // out of this function would leave that guard blind, so a webhook
  // redelivery would create a SECOND Shopify return for the same parcel. Null
  // degrades safely instead: `settleReturn` refuses a null transaction with
  // `no-refund-transaction`, which the cron alerts on.
  let refundSource: { transactionId: string | null; transactionAmount: string | null };
  try {
    refundSource = await refundSourceFor(dbOrder, result.data);
  } catch (error) {
    console.error(
      `Order ${id}: refundSourceFor failed after returnCreate succeeded — storing no refund transaction (settlement will alert):`,
      error
    );
    refundSource = { transactionId: null, transactionAmount: null };
  }

  // Matched on the fulfillment line item, never on array position — Shopify
  // makes no promise to echo the input order, and `return_line_item_id` is what
  // `returnRefund` later spends. Pairing by index would refund the wrong
  // garment.
  const returnLineItemByFulfillment = matchReturnLineItems(
    result.data.returnLineItems,
    lines
  );
  const confirmed = lines.flatMap((line) => {
    const returnLineItemId = line.fulfillmentLineItemId
      ? returnLineItemByFulfillment[line.fulfillmentLineItemId]
      : undefined;
    if (!returnLineItemId || line.productsorderId == null) {
      // Leave the row unconfirmed rather than store an id we did not receive.
      console.error(
        `Order ${id}: Shopify returned no return line item for row ${line.productsorderId} — row left unconfirmed`
      );
      return [];
    }
    return [
      {
        productsorderId: line.productsorderId,
        fulfillmentLineItemId: line.fulfillmentLineItemId as string,
        returnLineItemId,
      },
    ];
  });

  await recordConfirmation({
    submissionId,
    returnId: result.data.id,
    transactionId: refundSource.transactionId,
    transactionAmount: refundSource.transactionAmount,
    credit: submission.tender === "credit",
    lines: confirmed,
  });

  // The rows are now confirmed, which is the moment the customer has paid.
  // Hold the replacement stock so their size cannot sell out during the days
  // the parcel spends travelling back. Best-effort by construction — see
  // actions/exchangeReservation.ts.
  //
  // What is held is what was paid for: the submission's replacements, on the
  // rows Shopify accepted — not whatever the rows say by now.
  const confirmedIds = new Set(confirmed.map((line) => line.productsorderId));
  await reserveExchangeStock(
    id,
    agreed
      .filter((line) => confirmedIds.has(line.productsorderId))
      .map((line) => ({
        variant_id: String(rowById.get(line.productsorderId)?.variant_id ?? ""),
        action: line.action,
        new_variant_id: line.newVariantId,
        quantity: line.quantity,
        confirmed: true,
        refunded: rowById.get(line.productsorderId)?.refunded ?? false,
      }))
  );

  revalidatePath("/", "layout");
}
