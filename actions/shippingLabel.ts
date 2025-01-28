"use server";
import { getOrderById } from "@/db/queries";
import { base64img } from "@/placeholder";
import axios from "axios";

export async function createShippingLabel(id: string) {
  // Extraigo la info del pedido
  const order = await getOrderById(id);

  if (order) {
    const parts = order.shippingName.split(" ");
    let name = parts.slice(0, parts.length - 2).join(" "); // Combine all except the last two words - personas con dos nombres
    let firstSurname = parts[parts.length - 2]; // Second-to-last word
    if (name === "") {
      name = parts[0];
      firstSurname = parts[1];
      if (firstSurname === "") {
        firstSurname = name;
      }
    }
    let number = Number(order.shippingAddress1.match(/\d+/)?.[0]);
    if (!number) {
      number = 1;
    }
    const soapBody = `
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
               <Direccion>Calle Neptuno</Direccion>
               <Numero>29</Numero>
               <Localidad>Pozuelo de Alarcon</Localidad>
               <Provincia>Madrid</Provincia>
            </DatosDireccion>
            <CP>28224</CP>
            <Telefonocontacto>608667749</Telefonocontacto>
            <Email>hello@shamelesscollective.com</Email>
            <DatosSMS>
               <NumeroSMS>608667749</NumeroSMS>
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

    // Define the headers
    const headers = {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "PreRegistro",
    };
    const username = process.env.USERNAME_CORREOS;
    const password = process.env.PASSWORD_CORREOS;
    if (!username || !password) {
      // TO DO: AÑADIR AQUI ERROR HANDLING
      return 502;
    }
    try {
      const response = await axios.post(
        "https://preregistroenvios.correos.es/preregistroenvios",
        soapBody,
        {
          headers,
          auth: {
            username,
            password,
          },
        }
      );

      return sendEmailWithAttachment(response.data, order.email, name);
    } catch (error) {
      // TO DO: AÑADIR AQUI ERROR HANDLING
      console.error("Error:", error);
      return 501;
    }
  }
}
// Function to send an email with a PDF attachment
async function sendEmailWithAttachment(
  base64Pdf: string,
  recipientEmail: string,
  name: string
) {
  // Extract the Base64 encoded content using a regex
  const base64Match = base64Pdf.match(/<Fichero>(.*?)<\/Fichero>/);
  // Initialize the Postmark client with your Server Token
  if (process.env.POSTMARK_SERVER_TOKEN && base64Match) {
    try {
      const base64Content = base64Match[1];
      // Define the email payload
      const emailData = {
        From: "hello@shamelesscollective.com", // Verified sender address
        To: recipientEmail, // Recipient address
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
        MessageStream: "outbound", // Transactional email stream
        Attachments: [
          {
            Name: "Return_label.pdf", // File name
            Content: base64Content, // Base64-encoded PDF content
            ContentType: "application/pdf", // MIME type
          },
          {
            Name: "mail.jpg", // File name for the embedded image
            Content: base64img, // Base64-encoded content of the image
            ContentType: "image/jpeg", // MIME type for the image
            ContentID: "embedded-image", // Reference ID for embedding
          },
        ],
      };

      // Send the email via Postmark API
      const response = await axios.post(
        "https://api.postmarkapp.com/email",
        emailData,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN, // Server Token
          },
        }
      );

      console.log("Email sent successfully:", response.data.MessageID);
      return 200;
    } catch (error: any) {
      console.error(
        "Error sending email with Postmark:",
        error.response?.data || error.message
      );
      return 500;
    }
  }
}
