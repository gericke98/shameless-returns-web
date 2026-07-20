// Server-only module (reads secret env, hits the Amphora API + DB). Imported
// only by server actions / route handlers — NOT a "use server" action module,
// because it also exports the sync helper `isInternationalOrder`.
import db from "@/db/drizzle";
import { getOrderById, getVariantSkusByIds } from "@/db/queries";
import { orders } from "@/db/schema";
import axios from "axios";
import { eq } from "drizzle-orm";
import {
  amphoraOrderIdFromShopifyId,
  createAmphoraReturn,
  getAmphoraReturnsByOrderName,
  type AmphoraReturn,
} from "./amphora";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Spain (incl. Canarias/Ceuta/Melilla) stays on the Correos flow; everything
 *  else is routed to Amphora. Accepts the stored country name or an ISO code. */
export function isInternationalOrder(shippingCountry: string | null | undefined): boolean {
  const c = String(shippingCountry ?? "").trim().toLowerCase();
  if (!c) return false;
  const spain = ["spain", "españa", "espana", "es", "esp"];
  return !spain.includes(c);
}

async function sendAmphoraConfirmationEmail(
  recipientEmail: string,
  name: string,
  ret: AmphoraReturn
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;

  const trackingLine =
    ret.carrier_number && ret.carrier_url
      ? `<p style="font-size:16px;color:#555;">You can track the collection here: <a href="${ret.carrier_url}">${ret.carrier_number}</a>.</p>`
      : `<p style="font-size:16px;color:#555;">We will email you the tracking details as soon as the collection is scheduled.</p>`;

  const emailData = {
    From: "hello@shamelesscollective.com",
    To: recipientEmail,
    Subject: "Your return was successfully created",
    MessageStream: "outbound",
    TextBody:
      "Your return was successfully created. A courier will collect the item(s) from your address.",
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div style="margin-bottom:20px;">
          <p style="font-size:16px;color:#555;">Hello <strong>${name}</strong>,</p>
          <p style="font-size:16px;color:#555;">Thank you for initiating a return with <strong>Shameless Collective</strong>. Our courier will <strong>collect the item(s) from your address</strong> — you don't need to print anything.</p>
          <p style="font-size:16px;color:#555;">Please have the item(s) packaged and ready for collection.</p>
          ${trackingLine}
          <p style="font-size:16px;color:#555;">If you have any questions, contact us at <a href="mailto:hello@shamelesscollective.com">hello@shamelesscollective.com</a>.</p>
          <p style="font-size:16px;color:#555;">Best regards,<br/><strong>The Shameless Collective Team</strong></p>
        </div>
        <hr style="border:0;border-top:1px solid #ddd;margin:20px 0;"/>
        <div>
          <p style="font-size:16px;color:#555;">Hola <strong>${name}</strong>,</p>
          <p style="font-size:16px;color:#555;">Gracias por iniciar una devolución con <strong>Shameless Collective</strong>. Nuestro mensajero <strong>recogerá el/los artículo(s) en tu dirección</strong> — no necesitas imprimir nada.</p>
          <p style="font-size:16px;color:#555;">Ten el/los artículo(s) empaquetado(s) y listo(s) para la recogida.</p>
          <p style="font-size:16px;color:#555;">Si tienes alguna pregunta, escríbenos a <a href="mailto:hello@shamelesscollective.com">hello@shamelesscollective.com</a>.</p>
          <p style="font-size:16px;color:#555;">Saludos,<br/><strong>El equipo de Shameless Collective</strong></p>
        </div>
      </div>`,
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

    const emailStatus = await sendAmphoraConfirmationEmail(order.email, order.shippingName, ret!);
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
