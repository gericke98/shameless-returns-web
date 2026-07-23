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
import { base64img } from "@/placeholder";
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

/**
 * Fetch the full return object. The v3 `POST /returns` only returns
 * `{ return_id, parcel_id }` — the tracking number and label URL appear on the
 * return record once the carrier has announced it (status goes
 * no-label → announcing → ready-to-send in ~1-2s). Poll briefly until the label
 * is present; return the last response either way (best-effort).
 */
async function fetchSendcloudReturn(returnId: number, auth: string): Promise<any | null> {
  const url = `${SENDCLOUD_API}/returns/${returnId}`;
  let last: any = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const { data } = await axios.get(url, { headers: { Authorization: auth } });
      last = (data as any)?.data ?? data;
      // Readiness requires BOTH a populated tracking number AND the printable
      // label array. Immediately after create, the return briefly exposes a
      // `label_printer`/`label_url` *template* URL (which 404s) with an empty
      // tracking number — `label.normal_printer[]` only appears once the label
      // PDF actually exists. Keying on the template URL would exit too early.
      const trackingReady =
        typeof last?.tracking_number === "string" && last.tracking_number.length > 0;
      const labelReady = Boolean(last?.label?.normal_printer?.[0]);
      if (trackingReady && labelReady) return last;
    } catch {
      // transient (e.g. record not yet queryable) — retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

/**
 * Download the label PDF as base64. The Sendcloud label URL is an authenticated
 * API endpoint (401 without the API key), so it can't be emailed as a plain
 * link — we fetch it here with auth and attach the bytes to the email instead.
 */
async function downloadLabelBase64(labelUrl: string, auth: string): Promise<string | null> {
  try {
    const res = await axios.get(labelUrl, {
      headers: { Authorization: auth },
      responseType: "arraybuffer",
    });
    return Buffer.from(res.data as ArrayBuffer).toString("base64");
  } catch (error: any) {
    console.error(
      "Sendcloud label download failed:",
      error?.response?.status || error?.message || error
    );
    return null;
  }
}

async function sendSendcloudConfirmationEmail(
  recipientEmail: string,
  name: string,
  labelPdfBase64: string | null,
  tracking: string | null
): Promise<number> {
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken) return 500;
  // No label to attach → don't send a useless label-less email; signal failure
  // so the caller logs that this return needs a manual label send.
  if (!labelPdfBase64) {
    console.error("Sendcloud email: no label PDF to attach; skipping send");
    return 500;
  }

  const labelLine = `<p style="font-size:16px;color:#555;">Your pre-paid return label is attached to this email (PDF).</p>`;
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
          <p style="font-size:16px;color:#555;">Tu etiqueta de devolución prepagada está adjunta a este correo (PDF).</p>
          <p style="font-size:16px;color:#555;">Si tienes preguntas, escríbenos a <a href="mailto:hello@shamelesscollective.com">hello@shamelesscollective.com</a>.</p>
          <p style="font-size:16px;color:#555;">Saludos,<br/><strong>El equipo de Shameless Collective</strong></p>
        </div>
      </div>`,
    Attachments: [
      {
        Name: "Return_label.pdf",
        Content: labelPdfBase64,
        ContentType: "application/pdf",
      },
      {
        Name: "mail.jpg",
        Content: base64img,
        ContentType: "image/jpeg",
        ContentID: "embedded-image",
      },
    ],
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
    // The tracking number + label live on the return record, fetched next.
    const created: any = (data as any)?.data ?? data;
    const returnId = created?.return_id ?? created?.id;
    if (!returnId) {
      console.error(`Sendcloud return ${id}: no return_id in create response`, created);
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
    const labelUrl =
      ret?.label?.normal_printer?.[0] ??
      ret?.label?.label_printer ??
      ret?.label_url ??
      null;

    // Download the (auth-gated) label PDF now so we can attach it to the email.
    const labelPdfBase64 = labelUrl ? await downloadLabelBase64(labelUrl, auth) : null;
    if (!labelPdfBase64) {
      console.error(
        `Sendcloud return ${id}: created (return_id ${returnId}) but label not retrievable yet (labelUrl=${labelUrl}). Needs manual label send.`
      );
    }

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
      labelPdfBase64,
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
