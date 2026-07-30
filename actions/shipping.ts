"use server";
import db from "@/db/drizzle";
import { getOrderById } from "@/db/queries";
import { orders } from "@/db/schema";
import { base64img } from "@/placeholder";
import { buildCorreosEmail, type ExchangeInfo } from "@/lib/emails";
import { exchangeFromProducts } from "@/lib/exchange";
import { readLocale, type Locale } from "@/lib/i18n";
import axios from "axios";
import { eq } from "drizzle-orm";

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
              <Nombre>CORISA</Nombre>
              <Apellido1>TEXTIL</Apellido1>
            </Identificacion>
            <DatosDireccion>
              <Direccion>Calle Costa Rica 3 Escalera Izquierda 3G</Direccion>
              <Numero>3</Numero>
              <Localidad>Majadahonda</Localidad>
              <Provincia>Madrid</Provincia>
            </DatosDireccion>
            <CP>28221</CP>
            <Telefonocontacto>604141762</Telefonocontacto>
            <Email>hello@shamelesscollective.com</Email>
            <DatosSMS>
              <NumeroSMS>604141762</NumeroSMS>
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
  } catch (error: any) {
    console.error(
      `Correos label ${trackingNumber} IS REGISTERED for order ${id} but post-registration steps failed — tracking and/or the customer email may be missing. Needs manual follow-up. Error:`,
      error?.response?.data || error?.message || error
    );
  }

  return 200;
}

export async function obtainLastStatus(trackingNumber: string | null) {
  // Encode authentication (replace with your credentials)
  const username = process.env.USERNAME_CORREOS;
  const password = process.env.PASSWORD_CORREOS;
  const authToken = Buffer.from(`${username}:${password}`).toString("base64");

  // Construct request URL
  const url = `https://localizador.correos.es/canonico/eventos_envio_servicio_auth/${trackingNumber}?codIdioma=ES&indUltEvento=S`;
  // Make API request
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${authToken}`,
        "Content-Type": "application/json",
      },
    });
    // Caso de error
    if (!response.data[0].resumen_ultimo) {
      return "Prerregistrado";
    }
    // Return the tracking data
    return response.data[0].resumen_ultimo;
  } catch (error) {
    console.error("Error fetching tracking data:", error);
    return null;
  }
}
