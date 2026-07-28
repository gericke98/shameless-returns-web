// Pure builders for the transactional emails. No I/O, no env, no db — the
// action modules own the Postmark transport, this module only owns the copy and
// the markup. Kept out of the `"use server"` action files on purpose: those may
// only export async functions, so nothing in them can be unit-tested directly.
//
// Every email is SINGLE-language. The locale comes from `orders.locale`
// (written when the return is created) via `readLocale`, so the fallback is
// always "es".
import type { Locale } from "@/lib/i18n";

const FROM = "hello@shamelesscollective.com";
const MAILTO = `<a href="mailto:${FROM}">${FROM}</a>`;

export type EmailPayload = {
  From: string;
  To: string;
  Subject: string;
  TextBody: string;
  HtmlBody: string;
};

/* -------------------------------------------------------------------------- */
/* Correos (national) — pre-paid label attached as a PDF                       */
/* -------------------------------------------------------------------------- */

const CORREOS_COPY = {
  es: {
    subject: "Tu devolución se ha creado correctamente",
    text: "¡Tu devolución se ha creado correctamente!",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Gracias por iniciar un proceso de devolución con <strong>Shameless Collective</strong>. Adjunto encontrarás tu etiqueta de devolución para incluir en el paquete.",
    stepsTitle: "Pasos para completar tu devolución:",
    steps: [
      "Imprime la etiqueta de devolución adjunta (PDF).",
      "Empaqueta los artículos que deseas devolver en su envoltorio original.",
      "Coloca la etiqueta en el exterior del paquete.",
      "Lleva el paquete a tu oficina de <strong>Correos</strong> más cercana.",
    ],
    contact: "Si tienes alguna pregunta, no dudes en contactarnos en",
    closing: "¡Esperamos volver a verte pronto!",
    signoff:
      "Saludos cordiales,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your return was successfully created",
    text: "Your return was successfully created!",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Thank you for initiating a return with <strong>Shameless Collective</strong>. Attached is your return label to include with the package.",
    stepsTitle: "Steps to complete your return:",
    steps: [
      "Print the attached return label (PDF).",
      "Securely package the items you wish to return.",
      "Attach the label to the outside of your package.",
      "Drop off the package at your nearest <strong>Correos office</strong>.",
    ],
    contact: "If you have any questions, feel free to contact us at",
    closing: "We look forward to seeing you again!",
    signoff:
      "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildCorreosEmail(name: string, locale: Locale): EmailPayload {
  const c = CORREOS_COPY[locale];
  const p = 'style="font-size: 16px; color: #555;"';

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
        <!-- Logo Section -->
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
        </div>

        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          <p ${p}>${c.stepsTitle}</p>
          <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
            ${c.steps.map((s) => `<li style="margin-bottom: 10px;">${s}</li>`).join("")}
          </ol>
          <p ${p}>${c.contact}
            <a href="mailto:${FROM}" style="color: #0073e6; text-decoration: none;">${FROM}</a>.
          </p>
          <p ${p}>${c.closing}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>
    `,
  };
}

/* -------------------------------------------------------------------------- */
/* Amphora (international) — courier collects, nothing to print                */
/* -------------------------------------------------------------------------- */

const AMPHORA_COPY = {
  es: {
    subject: "Tu devolución se ha creado correctamente",
    text: "Tu devolución se ha creado correctamente. Un mensajero recogerá el/los artículo(s) en tu dirección.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Gracias por iniciar una devolución con <strong>Shameless Collective</strong>. Nuestro mensajero <strong>recogerá el/los artículo(s) en tu dirección</strong> — no necesitas imprimir nada.",
    ready:
      "Ten el/los artículo(s) empaquetado(s) y listo(s) para la recogida.",
    tracking: (number: string, url: string) =>
      `Puedes seguir la recogida aquí: <a href="${url}">${number}</a>.`,
    trackingPending:
      "Te enviaremos los datos de seguimiento en cuanto se programe la recogida.",
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your return was successfully created",
    text: "Your return was successfully created. A courier will collect the item(s) from your address.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Thank you for initiating a return with <strong>Shameless Collective</strong>. Our courier will <strong>collect the item(s) from your address</strong> — you don't need to print anything.",
    ready: "Please have the item(s) packaged and ready for collection.",
    tracking: (number: string, url: string) =>
      `You can track the collection here: <a href="${url}">${number}</a>.`,
    trackingPending:
      "We will email you the tracking details as soon as the collection is scheduled.",
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildAmphoraEmail(
  name: string,
  locale: Locale,
  tracking: { number?: string | null; url?: string | null }
): EmailPayload {
  const c = AMPHORA_COPY[locale];
  const p = 'style="font-size:16px;color:#555;"';
  const trackingLine =
    tracking.number && tracking.url
      ? `<p ${p}>${c.tracking(tracking.number, tracking.url)}</p>`
      : `<p ${p}>${c.trackingPending}</p>`;

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          <p ${p}>${c.ready}</p>
          ${trackingLine}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}

