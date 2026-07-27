// Server-only module (reads secret env, hits the Amphora API + DB). Imported
// only by server actions / route handlers — NOT a "use server" action module,
// because it also exports the sync helper `isInternationalOrder`.
import db from "@/db/drizzle";
import { getOrderById, getVariantSkusByIds } from "@/db/queries";
import { orders } from "@/db/schema";
import axios from "axios";
import { eq } from "drizzle-orm";
import { normalizeCountry } from "@/lib/countries";
import { buildAmphoraEmail } from "@/lib/emails";
import { readLocale, type Locale } from "@/lib/i18n";
import {
  amphoraOrderIdFromShopifyId,
  createAmphoraReturn,
  getAmphoraReturnsByOrderName,
  type AmphoraReturn,
} from "./amphora";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Spain (incl. Canarias/Ceuta/Melilla) stays on the Correos flow; everything
 *  else is routed to Amphora. Accepts the stored country name or an ISO code.
 *  An unrecognised country is treated as international, matching the previous
 *  behaviour (anything not in the Spain list was international). */
export function isInternationalOrder(shippingCountry: string | null | undefined): boolean {
  const raw = String(shippingCountry ?? "").trim();
  if (!raw) return false;
  return normalizeCountry(raw) !== "ES";
}

async function sendAmphoraConfirmationEmail(
  recipientEmail: string,
  name: string,
  ret: AmphoraReturn,
  locale: Locale
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;

  const emailData = {
    ...buildAmphoraEmail(name, locale, {
      number: ret.carrier_number,
      url: ret.carrier_url,
    }),
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

  try {
    // Idempotency guard: don't book a second collection if one already exists
    // for this order. We match on our own `external_id` (= order.id) rather than
    // trusting Amphora to dedupe — a double-submit (retry, refresh, webhook +
    // action race) must never result in two physical garment collections.
    const existing = await getAmphoraReturnsByOrderName(order.orderNumber);
    let ret: AmphoraReturn | undefined = existing.find((r) => r.external_id === order.id);
    const alreadyExisted = !!ret;

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

    // The carrier/tracking may not be assigned synchronously on a fresh create;
    // fall back to a read-back by order name (a ReturnTravelling webhook can
    // update it later). The reuse path already holds the latest record.
    if (!ret?.carrier_number && !alreadyExisted) {
      const back = await getAmphoraReturnsByOrderName(order.orderNumber);
      ret = back.find((r) => r.external_id === order.id) ?? back[0] ?? ret;
    }

    // DIAGNOSTIC (temporary): capture what Amphora returned so we can confirm
    // from the logs whether, after dropping `auto_approve`, the collection is
    // auto-arranged (carrier/tracking assigned, status advanced) or is sitting
    // unapproved (e.g. status CREATED + a supported "APPROVE" action).
    console.log(
      `[amphora] return created for order ${id}:`,
      JSON.stringify({
        return_id: ret?.id,
        external_id: ret?.external_id,
        internal_status: ret?.internal_status,
        carrier: ret?.carrier ?? null,
        carrier_number: ret?.carrier_number ?? null,
        carrier_url: ret?.carrier_url ?? null,
        supported_actions: (ret as any)?.supported_actions ?? null,
        reused_existing: alreadyExisted,
      })
    );

    // The collection is now booked — this is the point of no easy return. Persist
    // tracking and treat the operation as a SUCCESS from here on. A failed
    // confirmation email must NOT propagate as a failure: the caller reverts the
    // DB order on non-200, which would orphan an already-booked collection.
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
      ret!,
      readLocale(order.locale)
    );
    if (emailStatus !== 200) {
      // Best-effort: log loudly for manual follow-up, but the return succeeded.
      console.error(
        `Amphora return ${id}: collection booked but confirmation email failed (status ${emailStatus}). Customer needs a manual collection/tracking notice.`
      );
    }
    return 200;
  } catch (error: any) {
    console.error(
      `Amphora return failed for order ${id} (${order.shippingCountry}):`,
      error?.response?.data || error?.message || error
    );
    return 501;
  }
}
