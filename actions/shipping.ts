"use server";
import db from "@/db/drizzle";
import { getOrderById } from "@/db/queries";
import { orders } from "@/db/schema";
import { base64img } from "@/placeholder";
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
            <Ancho>20</Ancho>
          </Envio>
        </PreregistroEnvio>
      </soapenv:Body>
    </soapenv:Envelope>`;
}

function generateEmailTemplate(name: string) {
  return {
    From: "hello@shamelesscollective.com",
    To: "",
    Subject: "Your return was successfully created",
    TextBody: "Your return was successfully created!",
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
        <!-- Logo Section -->
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
        </div>
        
        <!-- English Section -->
        <div style="margin-bottom: 20px;">
          <p style="font-size: 16px; color: #555;">Hello <strong>${name}</strong>,</p>
          <p style="font-size: 16px; color: #555;">
            Thank you for initiating a return with <strong>Shameless Collective</strong>. Attached is your return label to include with the package.
          </p>
          <p style="font-size: 16px; color: #555;">Steps to complete your return:</p>
          <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
            <li style="margin-bottom: 10px;">Print the attached return label (PDF).</li>
            <li style="margin-bottom: 10px;">Securely package the items you wish to return.</li>
            <li style="margin-bottom: 10px;">Attach the label to the outside of your package.</li>
            <li style="margin-bottom: 10px;">Drop off the package at your nearest <strong>Correos office</strong>.</li>
          </ol>
          <p style="font-size: 16px; color: #555;">
            If you have any questions, feel free to contact us at 
            <a href="mailto:hello@shamelesscollective.com" style="color: #0073e6; text-decoration: none;">hello@shamelesscollective.com</a>.
          </p>
          <p style="font-size: 16px; color: #555;">We look forward to seeing you again!</p>
          <p style="font-size: 16px; color: #555;">
            Best regards,<br/>
            <strong>The Shameless Collective Team</strong>
          </p>
        </div>
        
        <!-- Separator -->
        <hr style="border: 0; border-top: 1px solid #ddd; margin: 20px 0;"/>

        <!-- Spanish Section -->
        <div>
          <p style="font-size: 16px; color: #555;">Hola <strong>${name}</strong>,</p>
          <p style="font-size: 16px; color: #555;">
            Gracias por iniciar un proceso de devolución con <strong>Shameless Collective</strong>. Adjunto encontrarás tu etiqueta de devolución para incluir en el paquete.
          </p>
          <p style="font-size: 16px; color: #555;">Pasos para completar tu devolución:</p>
          <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
            <li style="margin-bottom: 10px;">Imprime la etiqueta de devolución adjunta (PDF).</li>
            <li style="margin-bottom: 10px;">Empaqueta los artículos que deseas devolver en su envoltorio original.</li>
            <li style="margin-bottom: 10px;">Coloca la etiqueta en el exterior del paquete.</li>
            <li style="margin-bottom: 10px;">Lleva el paquete a tu oficina de <strong>Correos</strong> más cercana.</li>
          </ol>
          <p style="font-size: 16px; color: #555;">
            Si tienes alguna pregunta, no dudes en contactarnos en 
            <a href="mailto:hello@shamelesscollective.com" style="color: #0073e6; text-decoration: none;">hello@shamelesscollective.com</a>.
          </p>
          <p style="font-size: 16px; color: #555;">¡Esperamos volver a verte pronto!</p>
          <p style="font-size: 16px; color: #555;">
            Saludos cordiales,<br/>
            <strong>El equipo de Shameless Collective</strong>
          </p>
        </div>
      </div>
    `,
  };
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

    return { status: 200, data: response.data };
  } catch (error) {
    console.error("Shipping label error:", error);
    return { status: 501, error: "Failed to create shipping label" };
  }
}

async function sendEmail(
  base64Pdf: string,
  recipientEmail: string,
  name: string
): Promise<ShippingResponse> {
  const base64Match = base64Pdf.match(/<Fichero>(.*?)<\/Fichero>/);
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (!postmarkToken || !base64Match) {
    return { status: 500, error: "Missing required data" };
  }

  try {
    const emailTemplate = generateEmailTemplate(name);
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

export async function createShippingLabel(id: string): Promise<number> {
  const order = await getOrderById(id);
  if (!order) return 404;

  const { name, firstSurname } = parseShippingName(order.shippingName);
  const soapBody = generateSoapBody(order, name, firstSurname);

  const shippingResponse = await sendShippingLabel(soapBody);
  if (shippingResponse.status !== 200) return shippingResponse.status;
  // Extraigo el tracking number
  const trackingMatch = shippingResponse.data.match(
    /<CodEnvio>(.*?)<\/CodEnvio>/
  );
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;

  if (!trackingNumber) {
    console.error("Failed to extract tracking number from response");
    return 500;
  }
  await db
    .update(orders)
    .set({ locator: trackingNumber })
    .where(eq(orders.id, id));

  const emailResponse = await sendEmail(
    shippingResponse.data,
    order.email,
    name
  );
  return emailResponse.status;
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
