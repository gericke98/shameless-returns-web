// Server-only module (reads secret Sendcloud creds, hits the Sendcloud Returns
// API + DB). EU-only international returns: create a PRE-PAID drop-off return
// label (customer prints, drops at a local point) routed to the Spain warehouse.
//
// Scope: EU member states only (excl. Spain, which stays national/Correos).
// Non-EU lanes (GB, US, CH, NO, ...) are intentionally NOT handled here — a
// return crossing back into the EU is a customs import and needs returned-goods
// handling (Returned Goods Relief). That is a separate, later phase.
import db from "@/db/drizzle";
import { getOrderById } from "@/db/queries";
import { orders } from "@/db/schema";
import axios from "axios";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { EU_ISO2, normalizeCountry } from "@/lib/countries";
import { buildSendcloudEmail } from "@/lib/emails";
import { readLocale, type Locale } from "@/lib/i18n";

const SENDCLOUD_API = "https://panel.sendcloud.sc/api/v3";
const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

// Correos "Paq Return Internacional" (S0159) surfaced via Sendcloud — the EU
// return product where the customer drops off abroad and the parcel returns to
// Spain. Verified available for FR/DE/IT/NL/AT/GR/... -> ES via the API
// (/shipping-products?returns=true → code "correos:standardinternational",
// functionalities.returns = true).
const RETURN_PRODUCT_CODE = "correos:standardinternational";

// Where returns are delivered — the same address national Correos returns use
// (see actions/shipping.ts Destinatario).
const WAREHOUSE_ADDRESS = {
  name: "CORISA TEXTIL",
  address_line_1: "Calle Costa Rica 3 Escalera Izquierda 3G",
  postal_code: "28221",
  city: "Majadahonda",
  country_code: "ES",
} as const;

/**
 * Returns the ISO-2 code if the order is an in-scope EU return (EU member,
 * not Spain); otherwise null. Non-EU and Spain both fall through to their
 * existing flows.
 */
export function euIso2ForReturn(shippingCountry: string | null | undefined): string | null {
  const iso = normalizeCountry(shippingCountry);
  if (!iso || iso === "ES") return null; // Spain stays national
  return EU_ISO2.has(iso) ? iso : null; // only EU lanes handled here
}

function sendcloudAuthHeader(): string | null {
  const pub = process.env.SENDCLOUD_PUBLIC_KEY;
  const sec = process.env.SENDCLOUD_SECRET_KEY;
  if (!pub || !sec) return null;
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

/** ~0.5 kg per garment, clamped to the product's [0.5, 20] kg range. */
function estimateWeightKg(products: any[]): number {
  const items = products.reduce((n, p) => n + (Number(p.quantity) || 0), 0);
  return Math.max(0.5, Math.min(20, (items || 1) * 0.5));
}

/**
 * Fetch the full return object. The v3 `POST /returns` only returns
 * `{ return_id, parcel_id }` — the tracking number appears on the return record
 * once the carrier has announced it (status no-label → announcing →
 * ready-to-send in ~1-2s). Poll until the tracking number is populated; return
 * the last response either way (best-effort). We do NOT wait on the label PDF
 * here — it renders much later and is served on demand via the proxy route.
 */
async function fetchSendcloudReturn(returnId: number, auth: string): Promise<any | null> {
  const url = `${SENDCLOUD_API}/returns/${returnId}`;
  let last: any = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const { data } = await axios.get(url, { headers: { Authorization: auth } });
      last = (data as any)?.data ?? data;
      const trackingReady =
        typeof last?.tracking_number === "string" && last.tracking_number.length > 0;
      if (trackingReady) return last;
    } catch {
      // transient (e.g. record not yet queryable) — retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

/**
 * Build the customer-facing label link: a signed URL to our own proxy route
 * (`/api/return-label/[parcelId]`), which fetches the label from Sendcloud with
 * our API key at click time and streams the PDF. This avoids emailing the
 * auth-gated Sendcloud URL (401 for customers) and sidesteps the label's render
 * latency (it may not exist for tens of seconds after create). Signed with
 * HMAC(parcelId, SENDCLOUD_SECRET_KEY) so parcel ids can't be enumerated.
 */
function labelProxyUrl(parcelId: string | number): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.SENDCLOUD_SECRET_KEY;
  if (!base || !secret) return null;
  const pid = String(parcelId);
  const sig = crypto.createHmac("sha256", secret).update(pid).digest("hex");
  return `${base.replace(/\/$/, "")}/api/return-label/${pid}?sig=${sig}`;
}

async function sendSendcloudConfirmationEmail(
  recipientEmail: string,
  name: string,
  labelUrl: string | null,
  tracking: string | null,
  locale: Locale
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;
  // No label link → don't send a useless label-less email; signal failure so the
  // caller logs that this return needs a manual label send.
  if (!labelUrl) {
    console.error("Sendcloud email: no label link to send; skipping send");
    return 500;
  }

  const emailData = {
    ...buildSendcloudEmail(name, locale, labelUrl, tracking),
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
    console.error("Sendcloud email error:", error.response?.data || error.message);
    return 500;
  }
}

/**
 * Create an EU international return via Sendcloud (pre-paid drop-off label to the
 * Spain warehouse), persist tracking, and email the customer their label.
 * Returns an HTTP-style status (200 = success) to mirror `createShippingLabel`
 * so it slots into the same dispatch point.
 */
export async function createSendcloudReturn(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (!order) return 404;

  const countryCode = euIso2ForReturn(order.shippingCountry);
  if (!countryCode) {
    console.error(
      `Sendcloud return: order ${id} country '${order.shippingCountry}' is not an in-scope EU lane`
    );
    return 422;
  }

  const auth = sendcloudAuthHeader();
  if (!auth) {
    console.error("Sendcloud return: missing SENDCLOUD_PUBLIC_KEY/SECRET_KEY");
    return 500;
  }

  const products = (order as any).products ?? [];
  const payload = {
    from_address: {
      name: order.shippingName,
      address_line_1: order.shippingAddress1,
      postal_code: order.shippingZip,
      city: order.shippingCity,
      country_code: countryCode,
    },
    to_address: WAREHOUSE_ADDRESS,
    weight: { value: estimateWeightKg(products).toFixed(3), unit: "kg" },
    ship_with: { shipping_product_code: RETURN_PRODUCT_CODE },
  };

  try {
    const { data } = await axios.post(`${SENDCLOUD_API}/returns`, payload, {
      headers: { Authorization: auth, "Content-Type": "application/json" },
    });

    // v3 POST /returns returns only { return_id, parcel_id, multi_collo_ids }.
    // The tracking number lives on the return record (fetched next); the label
    // PDF is served on demand via the proxy route keyed by parcel_id.
    const created: any = (data as any)?.data ?? data;
    const returnId = created?.return_id ?? created?.id;
    const parcelId = created?.parcel_id ?? created?.parcel?.id;
    if (!returnId || !parcelId) {
      console.error(`Sendcloud return ${id}: missing return_id/parcel_id in create response`, created);
      return 501;
    }

    const ret = await fetchSendcloudReturn(returnId, auth);
    const tracking =
      ret?.tracking_number ?? ret?.parcel?.tracking_number ?? null;
    const carrierName =
      ret?.carrier?.code ??
      ret?.shipping_product?.code?.split(":")[0] ??
      "correos";
    const trackingUrl =
      ret?.tracking_url ?? ret?.parcel?.tracking_url ?? null;

    // Signed link to our label-proxy route (streams the PDF at click time, by
    // when it has rendered). Avoids the auth-gated URL + the render-latency race.
    const labelUrl = labelProxyUrl(parcelId);
    if (!labelUrl) {
      console.error(
        `Sendcloud return ${id}: created (return_id ${returnId}) but could not build label link (missing NEXT_PUBLIC_APP_URL/SECRET). Needs manual label send.`
      );
    }

    // The label is booked — treat as SUCCESS from here regardless of the email
    // outcome, so a failed email never causes the caller to revert an
    // already-created return (orphan-safe; same rule as the Amphora path).
    await db
      .update(orders)
      .set({ locator: tracking, carrier: carrierName, carrierUrl: trackingUrl })
      .where(eq(orders.id, id));

    // Language the customer chose in the portal, persisted on the order when the
    // return was created (see actions/return.ts). `readLocale` falls back to "es".
    const emailStatus = await sendSendcloudConfirmationEmail(
      order.email,
      order.shippingName,
      labelUrl,
      tracking,
      readLocale(order.locale)
    );
    if (emailStatus !== 200) {
      console.error(
        `Sendcloud return ${id}: label created but confirmation email failed (status ${emailStatus}). Customer needs a manual label send.`
      );
    }
    return 200;
  } catch (error: any) {
    console.error(
      `Sendcloud return failed for order ${id} (${order.shippingCountry}):`,
      error?.response?.data || error?.message || error
    );
    return 501;
  }
}
