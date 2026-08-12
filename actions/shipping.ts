"use server";
import db from "@/db/drizzle";
import { getOrderById } from "@/db/queries";
import { orders } from "@/db/schema";
import { base64img } from "@/placeholder";
import { buildCorreosEmail, type ExchangeInfo } from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import {
  UNKNOWN_TRACKING,
  parseCorreosTracking,
  carrierMovement,
  tracksWithCorreos,
  type CarrierMovement,
  type TrackingStatus,
} from "@/lib/trackingStatus";
import { readLocale, type Locale } from "@/lib/i18n";
import axios from "axios";
import { eq } from "drizzle-orm";
import { preregisterDomesticReturn } from "./amphoraReturn";

// Types
type ShippingResponse = {
  status: number;
  error?: string;
  data?: any;
};

// Constants
const CORREOS_API_URL =
  "https://preregistroenvios.correos.es/preregistroenvios";
const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

// Helper functions
function parseShippingName(fullName: string) {
  const parts = fullName.split(" ");
  let name = parts.slice(0, parts.length - 2).join(" ");
  let firstSurname = parts[parts.length - 2];

  if (name === "") {
    name = parts[0];
    firstSurname = parts[1] || parts[0];
  }

  return { name, firstSurname };
}

function extractAddressNumber(address: string): number {
  return Number(address.match(/\d+/)?.[0]) || 1;
}

function escapeXml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Correos requires CN23 customs data when a parcel crosses the EU customs
 * boundary. Our senders ship to a mainland warehouse, so this is needed only
 * when the SENDER is in the Canary Islands (35xxx / 38xxx), Ceuta (51xxx) or
 * Melilla (52xxx). Balearic Islands and the mainland are inside the EU customs
 * territory and must NOT include customs data.
 */
function requiresCustomsData(order: any): boolean {
  const zip = String(order.shippingZip ?? "").trim();
  return /^(35|38|51|52)/.test(zip);
}

/**
 * Builds the <Aduana> CN23 block injected inside <Envio>. Empty string when
 * customs data is not required. Verified against the Correos preregistro API:
 * TipoEnvio=4 (returned goods) + one <DATOSADUANA> line per product.
 */
function generateCustomsBlock(order: any): string {
  if (!requiresCustomsData(order)) return "";

  const products = Array.isArray(order.products) ? order.products : [];
  // Correos accepts up to 5 DATOSADUANA lines.
  const lines = products
    .slice(0, 5)
    .map(
      (p: any) => `
              <DATOSADUANA>
                <Cantidad>${p.quantity ?? 1}</Cantidad>
                <Descripcion>${escapeXml(String(p.title ?? "").slice(0, 100))}</Descripcion>
                <Pesoneto>500</Pesoneto>
                <Valorneto>${Math.max(1, Math.round(Number(p.price) || 0))}</Valorneto>
                <PaisOrigen>ES</PaisOrigen>
              </DATOSADUANA>`
    )
    .join("");

  return `
            <Aduana>
              <TipoEnvio>4</TipoEnvio>
              <DescAduanera>${lines}
              </DescAduanera>
            </Aduana>`;
}

/**
 * The pre-registration payload.
 *
 * `Remitente` is the customer sending the parcel back; `Destinatario` is where
 * it physically goes — Amphora, the 3PL that receives every return. That block
 * was still the previous warehouse (CORISA TEXTIL, Majadahonda 28221) long
 * after the move, so every domestic label printed sent the customer's parcel to
 * an address that no longer takes returns.
 *
 * Kept as a TS comment rather than an XML one: anything inside the template
 * literal is sent to Correos on the wire.
 *
 * Pinned by tests/correosDestination.test.ts — nothing else would notice this
 * drifting again.
 */
function generateSoapBody(order: any, name: string, firstSurname: string) {
  const number = extractAddressNumber(order.shippingAddress1);

  return `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://www.correos.es/iris6/services/preregistroetiquetas">
      <soapenv:Header/>
      <soapenv:Body>
        <PreregistroEnvio>
          <IdiomaErrores>EN</IdiomaErrores>
          <CodEtiquetador>${process.env.CODIGO_ETIQUETADOR_CORREOS}</CodEtiquetador>
          <ModDevEtiqueta>2</ModDevEtiqueta>
          <Remitente>
            <Identificacion>
              <Nombre>${name}</Nombre>
              <Apellido1>${firstSurname}</Apellido1>
            </Identificacion>
            <DatosDireccion>
              <Direccion>${order.shippingAddress1}</Direccion>
              <Numero>${number}</Numero>
              <Localidad>${order.shippingCity}</Localidad>
              <Provincia>${order.shippingProvince}</Provincia>
            </DatosDireccion>
            <CP>${order.shippingZip}</CP>
            <Telefonocontacto>${order.shippingPhone}</Telefonocontacto>
            <Email>${order.email}</Email>
          </Remitente>
          <Destinatario>
            <Identificacion>
              <Nombre>AMPHORA</Nombre>
              <Apellido1>LOGISTICS</Apellido1>
            </Identificacion>
            <DatosDireccion>
              <Direccion>Calle Pelaya 25, Poligono Industrial Rio de Janeiro</Direccion>
              <Numero>25</Numero>
              <Localidad>Algete</Localidad>
              <Provincia>Madrid</Provincia>
            </DatosDireccion>
            <CP>28110</CP>
            <Telefonocontacto>644371629</Telefonocontacto>
            <Email>hello@shamelesscollective.com</Email>
            <DatosSMS>
              <NumeroSMS>644371629</NumeroSMS>
              <Idioma>1</Idioma>
            </DatosSMS>
          </Destinatario>
          <Envio>
            <CodProducto>S0132</CodProducto>
            <TipoFranqueo>FP</TipoFranqueo>
            <ModalidadEntrega>ST</ModalidadEntrega>
            <Pesos>
              <Peso>
                <TipoPeso>R</TipoPeso>
                <Valor>100</Valor>
              </Peso>
            </Pesos>
            <Largo>30</Largo>
            <Alto>1</Alto>
            <Ancho>20</Ancho>${generateCustomsBlock(order)}
          </Envio>
        </PreregistroEnvio>
      </soapenv:Body>
    </soapenv:Envelope>`;
}

async function sendShippingLabel(soapBody: string): Promise<ShippingResponse> {
  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;

  if (!username || !password) {
    return { status: 502, error: "Missing credentials" };
  }

  try {
    const response = await axios.post(CORREOS_API_URL, soapBody, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: "PreRegistro",
      },
      auth: { username, password },
    });

    // Correos returns HTTP 200 even for business errors: a rejected shipment
    // has <Resultado>1</Resultado> with a <BultoError>/<DescError> and no
    // <CodEnvio>. Detect that here so callers don't mistake it for success.
    const body = String(response.data);
    const resultado = body.match(/<Resultado>(.*?)<\/Resultado>/)?.[1];
    const hasTracking = /<CodEnvio>(.*?)<\/CodEnvio>/.test(body);

    if (resultado !== "0" || !hasTracking) {
      const descError =
        body.match(/<DescError>([\s\S]*?)<\/DescError>/)?.[1]?.trim() ??
        "Unknown Correos error";
      const errorCode = body.match(/<Error>([\s\S]*?)<\/Error>/)?.[1]?.trim();
      console.error(
        `Correos rejected shipment (Resultado=${resultado}, Error=${errorCode}): ${descError}`
      );
      return { status: 501, error: descError };
    }

    return { status: 200, data: response.data };
  } catch (error) {
    console.error("Shipping label error:", error);
    return { status: 501, error: "Failed to create shipping label" };
  }
}

async function sendEmail(
  base64Pdf: string,
  recipientEmail: string,
  name: string,
  locale: Locale,
  exchange: ExchangeInfo | null
): Promise<ShippingResponse> {
  const base64Match = base64Pdf.match(/<Fichero>(.*?)<\/Fichero>/);
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken || !base64Match) {
    return { status: 500, error: "Missing required data" };
  }

  try {
    const emailTemplate = buildCorreosEmail(name, locale, exchange);
    const emailData = {
      ...emailTemplate,
      To: recipientEmail,
      MessageStream: "outbound",
      Attachments: [
        {
          Name: "Return_label.pdf",
          Content: base64Match[1],
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

    const result = await axios.post(POSTMARK_API_URL, emailData, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken,
      },
    });
    return { status: result.status };
  } catch (error: any) {
    console.error("Email error:", error.response?.data || error.message);
    return { status: 500, error: "Failed to send email" };
  }
}

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
export async function createShippingLabel(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (!order) return 404;

  // Idempotency, the same guard `updateFinalOrder` applies to the Shopify
  // return — and for the same reason, one step later.
  //
  // Order #311148 resubmitted five times on 2026-08-10, three seconds apart,
  // and got five "Tu devolución se ha creado correctamente" emails in eleven
  // seconds, each with its own Return_label.pdf. Nothing here checked, so that
  // is five pre-registered parcels and five charges for one box, of which our
  // database kept only the last — the other four are live at Correos and
  // invisible to us.
  //
  // A stored locator means this parcel already has a label. Report success: the
  // outcome the caller wants is already true, and /success shows the customer
  // the tracking we hold. Deliberately no second email — they were sent one
  // when the label was registered, and the duplicate is the complaint.
  if (order.locator) {
    console.warn(
      `Order ${id}: Correos label ${order.locator} already registered for this parcel — skipping creation (duplicate submit or webhook redelivery).`
    );
    return 200;
  }

  const { name, firstSurname } = parseShippingName(order.shippingName);
  const soapBody = generateSoapBody(order, name, firstSurname);

  const shippingResponse = await sendShippingLabel(soapBody);
  if (shippingResponse.status !== 200) {
    console.error(
      `Shipping label failed for order ${id} (${order.shippingZip} ${order.shippingProvince}): ${shippingResponse.error}`
    );
    return shippingResponse.status;
  }
  // Extraigo el tracking number
  const trackingMatch = shippingResponse.data.match(
    /<CodEnvio>(.*?)<\/CodEnvio>/
  );
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;

  if (!trackingNumber) {
    console.error(`Failed to extract tracking number for order ${id}`);
    return 500;
  }
  // The label is REGISTERED at Correos from here on. Both callers revert the
  // database whenever this returns anything but 200, and that revert cannot
  // un-register a label — it only hides a live return from the dashboard
  // (getReturns filters on `confirmed`) and leaves the customer with nothing.
  // So every failure below is logged for follow-up and swallowed: the return
  // exists, which is what the status code reports.
  try {
    await db
      .update(orders)
      .set({ locator: trackingNumber })
      .where(eq(orders.id, id));

    // Language the customer chose in the portal, persisted on the order when the
    // return was created (see actions/return.ts). `readLocale` falls back to "es".
    const emailResponse = await sendEmail(
      shippingResponse.data,
      order.email,
      name,
      readLocale(order.locale),
      exchangeFromProducts((order as any).products)
    );
    if (emailResponse.status !== 200) {
      console.error(
        `Correos label ${trackingNumber} registered for order ${id} but the confirmation email failed (status ${emailResponse.status}). Customer needs the label sending manually.`
      );
    }

    // Tell the warehouse a parcel is coming. Amphora receives every box, but
    // for a Spanish return it only ever found out on arrival — so nothing was
    // expected and nothing could be reconciled. Registered as EXTERNAL: they
    // record the return and our Correos tracking, and ship nothing themselves.
    //
    // Last, and best-effort: the label exists and the customer has been
    // emailed, so a warehouse-side failure must not touch either.
    await preregisterDomesticReturn(order as any, trackingNumber);
  } catch (error: any) {
    console.error(
      `Correos label ${trackingNumber} IS REGISTERED for order ${id} but post-registration steps failed — tracking and/or the customer email may be missing. Needs manual follow-up. Error:`,
      error?.response?.data || error?.message || error
    );
  }

  return 200;
}

/**
 * Ask Correos for the latest event on a parcel.
 *
 * Returns a {label, phase} pair, never a bare string, and never a status it
 * did not receive. The previous version answered "Prerregistrado" whenever
 * `resumen_ultimo` was empty — which is also what Correos returns for a parcel
 * it has no record of, so 82 of 415 live locators (all long-since delivered,
 * aged out of Correos's traceability) were reported to ops as sitting
 * undeposited. Parsing lives in lib/trackingStatus.ts so those cases are
 * pinned by tests against real payloads.
 */
export async function obtainLastStatus(
  trackingNumber: string | null
): Promise<TrackingStatus> {
  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;
  if (!trackingNumber || !username || !password) return UNKNOWN_TRACKING;

  const authToken = Buffer.from(`${username}:${password}`).toString("base64");
  const url = `https://localizador.correos.es/canonico/eventos_envio_servicio_auth/${encodeURIComponent(
    trackingNumber
  )}?codIdioma=ES&indUltEvento=S`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${authToken}`,
        "Content-Type": "application/json",
      },
    });
    return parseCorreosTracking(response.data);
  } catch (error) {
    // A network failure is not evidence about the parcel. Report "unknown"
    // rather than any status that implies we learned something.
    console.error(`Error fetching tracking data for ${trackingNumber}:`, error);
    return UNKNOWN_TRACKING;
  }
}

/**
 * Ask Correos whether this parcel has moved.
 *
 * ONLY Correos, and only when the parcel actually travels with Correos.
 * `orders.locator` is overloaded: for a Spanish return it holds a Correos
 * CodEnvio, but for an international one `actions/amphoraReturn.ts` writes
 * Amphora's `carrier_number` there — a UPS/DHL/GLS reference. Handing that to
 * the localizador returns an error block, which reads as "unreadable", which
 * `cancelEligibility` turns into `carrier-unreadable` and shows the customer
 * "try again in a few minutes" — a retry that can never succeed. That killed
 * cancellation for the whole non-Spain lane.
 *
 * So a non-Correos parcel answers "not-moved" with no network call. That is
 * not a claim that it is sitting still: movement for those returns is carried
 * by the Amphora `returnStatus` gate in `cancelEligibility` (TRAVELLING,
 * RECEIVED, … all block), which is the only signal we actually have for them.
 *
 * `carrier` is matched by NAME via `tracksWithCorreos`, not by presence:
 * Amphora subcontracts Correos for some destinations and sets `carrier` to
 * "correos" with a real Correos code, and those must still be queried.
 *
 * A null locator is "not-moved", not "unreadable": an international return
 * Amphora has not assigned a carrier to has no tracking number and certainly
 * has no parcel in transit. A domestic return with no locator never got a
 * label at all.
 *
 * Any transport failure on a parcel we CAN ask about is "unreadable", which
 * blocks cancellation.
 */
export async function readCarrierMovement(
  locator: string | null | undefined,
  carrier?: string | null
): Promise<CarrierMovement> {
  if (!locator) return "not-moved";
  if (!tracksWithCorreos(carrier)) return "not-moved";

  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;
  if (!username || !password) return "unreadable";

  const authToken = Buffer.from(`${username}:${password}`).toString("base64");
  const url = `https://localizador.correos.es/canonico/eventos_envio_servicio_auth/${encodeURIComponent(
    locator
  )}?codIdioma=ES&indUltEvento=S`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${authToken}`,
        "Content-Type": "application/json",
      },
    });
    return carrierMovement(response.data);
  } catch (error) {
    console.error(`Could not read movement for ${locator}:`, error);
    return "unreadable";
  }
}
