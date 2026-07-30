// Server-only module (reads secret env, hits the Amphora API + DB). Imported
// only by server actions / route handlers — NOT a "use server" action module,
// because it also exports the sync helper `isInternationalOrder`.
import db from "@/db/drizzle";
import { getOrderById, getVariantSkusByIds } from "@/db/queries";
import { orders } from "@/db/schema";
import axios from "axios";
import { eq } from "drizzle-orm";
import { normalizeCountry } from "@/lib/countries";
import { buildAmphoraEmail, type ExchangeInfo } from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import { readLocale, type Locale } from "@/lib/i18n";
import {
  amphoraOrderIdFromShopifyId,
  createAmphoraReturn,
  getAmphoraReturnsByOrderName,
  type AmphoraReturn,
} from "./amphora";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Spain (incl. Canarias/Ceuta/Melilla) stays on the Correos flow; everything
 *  else is routed to Amphora. Re-exported from lib/countries.ts, which is pure
 *  — the return-method screen is a client component and needs the same rule,
 *  and must not import this module (Neon client, Amphora API). */
export { isInternationalOrder } from "@/lib/countries";

async function sendAmphoraConfirmationEmail(
  recipientEmail: string,
  name: string,
  // Optional on purpose: this used to be dereferenced through a `!`, so a
  // missing record threw straight into the caller's revert path — turning a
  // cosmetic gap (no tracking yet) into a lost return.
  ret: AmphoraReturn | undefined,
  locale: Locale,
  exchange: ExchangeInfo | null
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;

  const emailData = {
    ...buildAmphoraEmail(
      name,
      locale,
      { number: ret?.carrier_number, url: ret?.carrier_url },
      exchange
    ),
    To: recipientEmail,
    MessageStream: "outbound",
  };

  try {
    const res = await axios.post(POSTMARK_API_URL, emailData, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken,
      },
    });
    return res.status;
  } catch (error: any) {
    console.error("Amphora email error:", error.response?.data || error.message);
    return 500;
  }
}

/**
 * Create an international return via Amphora (carrier + garment collection),
 * persist tracking, and email the customer a collection confirmation.
 * Returns an HTTP-style status (200 = success) to mirror `createShippingLabel`
 * so it slots into the same dispatch point in the return flow.
 */
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
export async function createInternationalReturn(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (!order) return 404;

  const products = (order as any).products ?? [];
  const returnedProducts = products.filter(
    (p: any) => p.variant_id && Number(p.quantity) > 0
  );
  if (returnedProducts.length === 0) {
    console.error(`Amphora return: no returnable products for order ${id}`);
    return 500;
  }

  // Map variant ids -> Amphora/Shopify SKUs.
  const skusById = await getVariantSkusByIds(
    returnedProducts.map((p: any) => String(p.variant_id))
  );
  const items = returnedProducts
    .map((p: any) => ({ sku: skusById[String(p.variant_id)], quantity: Number(p.quantity) }))
    .filter((i: any) => i.sku);

  if (items.length === 0) {
    console.error(`Amphora return: could not resolve any SKUs for order ${id}`);
    return 500;
  }
  if (items.length !== returnedProducts.length) {
    console.error(
      `Amphora return: resolved ${items.length}/${returnedProducts.length} SKUs for order ${id}`
    );
  }

  /** Ask Amphora whether a collection for THIS order exists right now. */
  const findBooked = async (): Promise<AmphoraReturn | undefined> => {
    const all = await getAmphoraReturnsByOrderName(order.orderNumber);
    return all.find((r) => r.external_id === order.id);
  };

  // ── Phase 1: book the collection ──────────────────────────────────────────
  // The only phase whose failure is safe to report. Until Amphora holds a
  // return for this order, nothing external exists and the caller's revert is
  // both correct and harmless.
  let ret: AmphoraReturn | undefined;
  let alreadyExisted = false;
  try {
    // Idempotency guard: don't book a second collection if one already exists
    // for this order. We match on our own `external_id` (= order.id) rather than
    // trusting Amphora to dedupe — a double-submit (retry, refresh, webhook +
    // action race) must never result in two physical garment collections.
    ret = await findBooked();
    alreadyExisted = !!ret;

    if (ret) {
      console.warn(
        `Amphora return already exists for order ${id} (external_id match) — reusing, not booking a new collection.`
      );
    } else {
      ret = await createAmphoraReturn({
        orderId: amphoraOrderIdFromShopifyId(order.id),
        items,
        externalId: order.id,
        time: new Date().toISOString(),
        name: order.orderNumber,
        customerEmail: order.email,
        autoApprove: true,
      });
    }
  } catch (error: any) {
    // The POST can fail on the RESPONSE while Amphora has already committed the
    // return — a timeout or a dropped socket looks identical to a rejected
    // request from here. Reverting on that assumption strands a real courier
    // pickup, so ask Amphora before concluding nothing happened.
    let recovered: AmphoraReturn | undefined;
    try {
      recovered = await findBooked();
    } catch {
      // Can't reach Amphora to check either. Fall through and report failure:
      // the caller reverts, which is the recoverable direction when we have no
      // evidence a collection exists.
    }

    if (!recovered) {
      console.error(
        `Amphora return failed for order ${id} (${order.shippingCountry}) — no collection booked:`,
        error?.response?.data || error?.message || error
      );
      return 501;
    }

    console.error(
      `Amphora return for order ${id}: create call failed but Amphora HAS the collection (${recovered.id}) — treating as booked, not reverting. Original error:`,
      error?.response?.data || error?.message || error
    );
    ret = recovered;
    alreadyExisted = true;
  }

  // ── Phase 2: everything after the collection exists ───────────────────────
  // The point of no easy return. Both callers revert the database whenever this
  // function returns anything but 200, and that revert cannot un-book a courier
  // or close the Shopify return — it only makes our records disagree with
  // reality and hides the order from the dashboard. So from here every failure
  // is logged for follow-up and swallowed: the return HAS been created, which
  // is what the status code reports.
  try {
    // The carrier/tracking may not be assigned synchronously on a fresh create;
    // fall back to a read-back by order name (a ReturnTravelling webhook can
    // update it later). The reuse path already holds the latest record.
    if (!ret?.carrier_number && !alreadyExisted) {
      const back = await getAmphoraReturnsByOrderName(order.orderNumber);
      ret = back.find((r) => r.external_id === order.id) ?? back[0] ?? ret;
    }

    console.log(
      `[amphora] return booked for order ${id}:`,
      JSON.stringify({
        return_id: ret?.id,
        external_id: ret?.external_id,
        internal_status: ret?.internal_status,
        carrier: ret?.carrier ?? null,
        carrier_number: ret?.carrier_number ?? null,
        carrier_url: ret?.carrier_url ?? null,
        reused_existing: alreadyExisted,
      })
    );

    await db
      .update(orders)
      .set({
        locator: ret?.carrier_number ?? null,
        carrier: ret?.carrier ?? null,
        carrierUrl: ret?.carrier_url ?? null,
      })
      .where(eq(orders.id, id));

    // Language the customer chose in the portal, persisted on the order when the
    // return was created (see actions/return.ts). `readLocale` falls back to "es".
    const emailStatus = await sendAmphoraConfirmationEmail(
      order.email,
      order.shippingName,
      ret,
      readLocale(order.locale),
      exchangeFromProducts(products)
    );
    if (emailStatus !== 200) {
      // Best-effort: log loudly for manual follow-up, but the return succeeded.
      console.error(
        `Amphora return ${id}: collection booked but confirmation email failed (status ${emailStatus}). Customer needs a manual collection/tracking notice.`
      );
    }
  } catch (error: any) {
    console.error(
      `Amphora return ${id}: COLLECTION IS BOOKED but post-booking steps failed — tracking and/or the customer email may be missing. Needs manual follow-up. Error:`,
      error?.response?.data || error?.message || error
    );
  }

  return 200;
}
