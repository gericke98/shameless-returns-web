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
import { eq } from "drizzle-orm";

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

// EU member states (ISO-2). Spain is national (Correos) and excluded below.
const EU_ISO2 = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "SE",
]);

// Shopify stores the country as a display name (e.g. "France") or sometimes an
// ISO code. Map the names we actually see to ISO-2.
const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  austria: "AT", belgium: "BE", bulgaria: "BG", croatia: "HR", cyprus: "CY",
  "czech republic": "CZ", czechia: "CZ", denmark: "DK", estonia: "EE",
  finland: "FI", france: "FR", germany: "DE", greece: "GR", hungary: "HU",
  ireland: "IE", italy: "IT", latvia: "LV", lithuania: "LT", luxembourg: "LU",
  malta: "MT", netherlands: "NL", poland: "PL", portugal: "PT", romania: "RO",
  slovakia: "SK", slovenia: "SI", sweden: "SE",
};

/**
 * Returns the ISO-2 code if the order is an in-scope EU return (EU member,
 * not Spain); otherwise null. Non-EU and Spain both fall through to their
 * existing flows.
 */
export function euIso2ForReturn(shippingCountry: string | null | undefined): string | null {
  const raw = String(shippingCountry ?? "").trim();
  if (!raw) return null;
  const iso =
    raw.length === 2 ? raw.toUpperCase() : COUNTRY_NAME_TO_ISO2[raw.toLowerCase()] ?? null;
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

async function sendSendcloudConfirmationEmail(
  recipientEmail: string,
  name: string,
  labelUrl: string | null,
  tracking: string | null
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;

  const labelLine = labelUrl
    ? `<p style="font-size:16px;color:#555;">Your pre-paid return label: <a href="${labelUrl}">download &amp; print it here</a>.</p>`
    : `<p style="font-size:16px;color:#555;">We'll email your pre-paid return label shortly.</p>`;
  const trackingLine = tracking
    ? `<p style="font-size:16px;color:#555;">Tracking number: <strong>${tracking}</strong>.</p>`
    : "";

  const emailData = {
    From: "hello@shamelesscollective.com",
    To: recipientEmail,
    Subject: "Your return label is ready",
    MessageStream: "outbound",
    TextBody:
      "Your return was created. Print the attached pre-paid label and drop the parcel at your nearest drop-off point.",
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div style="margin-bottom:20px;">
          <p style="font-size:16px;color:#555;">Hello <strong>${name}</strong>,</p>
          <p style="font-size:16px;color:#555;">Thank you for initiating a return with <strong>Shameless Collective</strong>. Here's how to complete it:</p>
          <ol style="font-size:16px;color:#555;margin-left:20px;padding-left:10px;">
            <li>Print your pre-paid return label.</li>
            <li>Package the item(s) securely and attach the label.</li>
            <li>Drop the parcel at your nearest drop-off point.</li>
          </ol>
          ${labelLine}
          ${trackingLine}
          <p style="font-size:16px;color:#555;">Questions? <a href="mailto:hello@shamelesscollective.com">hello@shamelesscollective.com</a>.</p>
          <p style="font-size:16px;color:#555;">Best regards,<br/><strong>The Shameless Collective Team</strong></p>
        </div>
        <hr style="border:0;border-top:1px solid #ddd;margin:20px 0;"/>
        <div>
          <p style="font-size:16px;color:#555;">Hola <strong>${name}</strong>,</p>
          <p style="font-size:16px;color:#555;">Gracias por iniciar una devolución con <strong>Shameless Collective</strong>. Para completarla:</p>
          <ol style="font-size:16px;color:#555;margin-left:20px;padding-left:10px;">
            <li>Imprime tu etiqueta de devolución prepagada.</li>
            <li>Empaqueta el/los artículo(s) y pega la etiqueta.</li>
            <li>Deja el paquete en tu punto de entrega más cercano.</li>
          </ol>
          <p style="font-size:16px;color:#555;">Si tienes preguntas, escríbenos a <a href="mailto:hello@shamelesscollective.com">hello@shamelesscollective.com</a>.</p>
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

    // Response field paths follow Sendcloud v3 conventions; confirm/adjust the
    // exact keys on the first live test-create (logged in full on failure).
    const ret: any = (data as any)?.data ?? data;
    const tracking =
      ret?.tracking_number ?? ret?.parcel?.tracking_number ?? null;
    const carrierName =
      ret?.ship_with?.carrier ?? ret?.carrier?.code ?? "correos";
    const trackingUrl =
      ret?.tracking_url ?? ret?.parcel?.tracking_url ?? null;
    const labelUrl =
      ret?.label?.normal_printer?.[0] ??
      ret?.label?.label_printer ??
      ret?.label?.url ??
      null;

    // The label is booked — treat as SUCCESS from here regardless of the email
    // outcome, so a failed email never causes the caller to revert an
    // already-created return (orphan-safe; same rule as the Amphora path).
    await db
      .update(orders)
      .set({ locator: tracking, carrier: carrierName, carrierUrl: trackingUrl })
      .where(eq(orders.id, id));

    const emailStatus = await sendSendcloudConfirmationEmail(
      order.email,
      order.shippingName,
      labelUrl,
      tracking
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
