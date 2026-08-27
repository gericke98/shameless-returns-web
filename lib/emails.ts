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

/**
 * Passed when the customer is swapping items rather than returning them.
 *
 * Presence is the signal — a CAMBIO and a DEVOLUCIÓN otherwise produce byte
 * identical emails, which is how somebody who paid to change a size ended up
 * being told only that a "return" had been created.
 *
 * `replacements` are ready-to-print lines ("STAR AMALFI PANTS — Medium (40)").
 * It may be empty: the exchange framing still applies, we just cannot name what
 * is coming, so the copy stays vague rather than dangling.
 */
export type ExchangeInfo = {
  replacements: string[];
};

/* The exchange wording is identical whichever way the parcel travels, so it
 * lives here rather than being duplicated into both delivery templates. Only
 * the intro sentence is per-template, because it also describes the shipping. */
const EXCHANGE_COPY = {
  es: {
    subject: "Tu cambio se ha confirmado",
    text: "Tu cambio se ha confirmado.",
    replacements: (items: string[]) =>
      `Cuando recibamos tu devolución, te enviaremos tu reemplazo: <strong>${items.join(
        ", "
      )}</strong>.`,
    replacementsUnknown:
      "Cuando recibamos tu devolución, te enviaremos el/los artículo(s) que has seleccionado.",
  },
  en: {
    subject: "Your exchange is confirmed",
    text: "Your exchange is confirmed.",
    replacements: (items: string[]) =>
      `Once we receive your return, we'll ship your replacement: <strong>${items.join(
        ", "
      )}</strong>.`,
    replacementsUnknown:
      "Once we receive your return, we'll ship the item(s) you selected.",
  },
} as const;

/** The exchange paragraph, or "" for a plain return. */
function exchangeLine(
  locale: Locale,
  exchange: ExchangeInfo | null | undefined,
  style: string
): string {
  if (!exchange) return "";
  const x = EXCHANGE_COPY[locale];
  const body = exchange.replacements.length
    ? x.replacements(exchange.replacements)
    : x.replacementsUnknown;
  return `<p ${style}>${body}</p>`;
}

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
    introExchange:
      "Gracias por iniciar un cambio con <strong>Shameless Collective</strong>. Adjunto encontrarás tu etiqueta de devolución para incluir en el paquete.",
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
    introExchange:
      "Thank you for initiating an exchange with <strong>Shameless Collective</strong>. Attached is your return label to include with the package.",
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

export function buildCorreosEmail(
  name: string,
  locale: Locale,
  exchange?: ExchangeInfo | null
): EmailPayload {
  const c = CORREOS_COPY[locale];
  const p = 'style="font-size: 16px; color: #555;"';

  return {
    From: FROM,
    To: "",
    Subject: exchange ? EXCHANGE_COPY[locale].subject : c.subject,
    TextBody: exchange ? EXCHANGE_COPY[locale].text : c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
        <!-- Logo Section -->
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
        </div>

        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${exchange ? c.introExchange : c.intro}</p>
          <p ${p}>${c.stepsTitle}</p>
          <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
            ${c.steps.map((s) => `<li style="margin-bottom: 10px;">${s}</li>`).join("")}
          </ol>
          ${exchangeLine(locale, exchange, p)}
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
    introExchange:
      "Gracias por iniciar un cambio con <strong>Shameless Collective</strong>. Nuestro mensajero <strong>recogerá el/los artículo(s) en tu dirección</strong> — no necesitas imprimir nada.",
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
    introExchange:
      "Thank you for initiating an exchange with <strong>Shameless Collective</strong>. Our courier will <strong>collect the item(s) from your address</strong> — you don't need to print anything.",
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
  tracking: { number?: string | null; url?: string | null },
  exchange?: ExchangeInfo | null
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
    Subject: exchange ? EXCHANGE_COPY[locale].subject : c.subject,
    TextBody: exchange ? EXCHANGE_COPY[locale].text : c.text,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${c.greeting(name)}</p>
          <p ${p}>${exchange ? c.introExchange : c.intro}</p>
          <p ${p}>${c.ready}</p>
          ${exchangeLine(locale, exchange, p)}
          ${trackingLine}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}


/* -------------------------------------------------------------------------- */
/* Lifecycle notifications — driven by the Amphora return-status webhooks      */
/*                                                                            */
/* Separate builders on purpose. Reusing buildAmphoraEmail here would send a   */
/* second "Your return was successfully created", which the customer already   */
/* has; these describe what changed since.                                     */
/* -------------------------------------------------------------------------- */

const SCHEDULED_COPY = {
  es: {
    subject: "Tu recogida está programada",
    text: "Tu recogida está programada.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Ya hemos programado la recogida de tu devolución. El mensajero pasará por tu dirección — no necesitas imprimir nada.",
    tracking: (number: string, url: string) =>
      `Puedes seguir la recogida aquí: <a href="${url}">${number}</a>.`,
    trackingPlain: (number: string) =>
      `Número de seguimiento: <strong>${number}</strong>.`,
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your collection is scheduled",
    text: "Your collection is scheduled.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Your return collection is now scheduled. The courier will come to your address — you don't need to print anything.",
    tracking: (number: string, url: string) =>
      `You can track the collection here: <a href="${url}">${number}</a>.`,
    trackingPlain: (number: string) =>
      `Tracking number: <strong>${number}</strong>.`,
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildCollectionScheduledEmail(
  name: string,
  locale: Locale,
  tracking: { number?: string | null; url?: string | null },
  exchange?: ExchangeInfo | null
): EmailPayload {
  const c = SCHEDULED_COPY[locale];
  const p = 'style="font-size:16px;color:#555;"';
  // Amphora can assign a number without a customer-facing URL; show what we
  // have rather than dropping the tracking entirely.
  const trackingLine = tracking.number
    ? `<p ${p}>${
        tracking.url
          ? c.tracking(tracking.number, tracking.url)
          : c.trackingPlain(tracking.number)
      }</p>`
    : "";

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
          ${trackingLine}
          ${exchangeLine(locale, exchange, p)}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}

const RECEIVED_COPY = {
  es: {
    subject: "Hemos recibido tu devolución",
    text: "Hemos recibido tu devolución.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Tu devolución ya ha llegado a nuestro almacén y la estamos revisando.",
    outcomeReturn:
      "En cuanto termine la revisión procesaremos tu reembolso. Te avisaremos.",
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "We've received your return",
    text: "We've received your return.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "Your return has arrived at our warehouse and we're checking it now.",
    outcomeReturn:
      "As soon as the check is complete we'll process your refund. We'll let you know.",
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildReturnReceivedEmail(
  name: string,
  locale: Locale,
  exchange?: ExchangeInfo | null
): EmailPayload {
  const c = RECEIVED_COPY[locale];
  const p = 'style="font-size:16px;color:#555;"';
  // An exchange customer is owed their replacement, not a refund — the two
  // outcomes are mutually exclusive.
  const outcome = exchange
    ? exchangeLine(locale, exchange, p)
    : `<p ${p}>${c.outcomeReturn}</p>`;

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
          ${outcome}
          <p ${p}>${c.contact}</p>
          <p ${p}>${c.signoff}</p>
        </div>
      </div>`,
  };
}

/**
 * Where the customer's return has got to.
 *
 * One builder for all four milestones rather than four near-identical ones —
 * the wrapper markup is the same in every case and only the sentences differ.
 *
 * The `received` copy deliberately promises no refund TIMELINE. Settlement is a
 * separate job with its own grace period, and a date this email cannot keep is
 * worse than no date.
 */
const TRACKING_COPY = {
  es: {
    accepted: {
      subject: "Tu devolución está en camino",
      intro: "Correos ya tiene tu paquete. A partir de aquí nos encargamos nosotros.",
    },
    in_transit: {
      subject: "Tu devolución va de camino a nuestro almacén",
      intro: "Tu paquete está en tránsito hacia nuestro almacén.",
    },
    received: {
      subject: "Hemos recibido tu devolución",
      intro:
        "Tu devolución ya ha llegado a nuestro almacén y la estamos revisando. Te avisaremos en cuanto esté procesada.",
    },
    problem: {
      subject: "Incidencia con tu devolución",
      intro:
        "Ha habido una incidencia con el envío de tu devolución y necesitamos revisarlo contigo.",
    },
  },
  en: {
    accepted: {
      subject: "Your return is on its way",
      intro: "The carrier has your parcel. We'll take it from here.",
    },
    in_transit: {
      subject: "Your return is heading to our warehouse",
      intro: "Your parcel is in transit to our warehouse.",
    },
    received: {
      subject: "We've received your return",
      intro:
        "Your return has arrived at our warehouse and we're checking it now. We'll let you know once it's processed.",
    },
    problem: {
      subject: "There's a problem with your return",
      intro:
        "Something went wrong with your return shipment and we need to look into it with you.",
    },
  },
} as const;

const TRACKING_TAIL = {
  es: {
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    contact: `Si tienes alguna pregunta, escríbenos a ${MAILTO}.`,
    signoff: "Saludos,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    contact: `If you have any questions, contact us at ${MAILTO}.`,
    signoff: "Best regards,<br/><strong>The Shameless Collective Team</strong>",
  },
} as const;

export function buildTrackingUpdateEmail(
  key: "accepted" | "in_transit" | "received" | "problem",
  name: string,
  locale: Locale
): EmailPayload {
  const c = TRACKING_COPY[locale][key];
  const t = TRACKING_TAIL[locale];
  const p = 'style="font-size:16px;color:#555;"';

  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.intro,
    HtmlBody: `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#333; background:#f9f9f9; padding:20px; border:1px solid #ddd; border-radius:8px; max-width:600px; margin:20px auto;">
        <div>
          <p ${p}>${t.greeting(name)}</p>
          <p ${p}>${c.intro}</p>
          <p ${p}>${t.contact}</p>
          <p ${p}>${t.signoff}</p>
        </div>
      </div>`,
  };
}

/* -------------------------------------------------------------------------- */
/* Self-booked — the customer arranges their own courier                      */
/* -------------------------------------------------------------------------- */

/** Where the customer posts the parcel. Same warehouse the Correos label is
 *  addressed to — see generateSoapBody in actions/shipping.ts. */
const WAREHOUSE_ADDRESS = [
  "Shameless Collective (Amphora Logistics)",
  "Calle Pelaya 25, Poligono Industrial Rio de Janeiro",
  "28110 Algete, Madrid",
  "España",
].join("<br/>");

const SELF_COPY = {
  es: {
    subject: "Tu devolución: envíala cuando quieras",
    reminderSubject: "¿Ya has enviado tu devolución?",
    text: "Tu devolución se ha creado. Envíala con el transportista que prefieras.",
    greeting: (name: string) => `Hola <strong>${name}</strong>,`,
    intro:
      "Has elegido enviar tu devolución por tu cuenta, así que <strong>no adjuntamos ninguna etiqueta</strong> — el envío lo organizas tú, con el transportista que prefieras.",
    stepsTitle: "Pasos para completar tu devolución:",
    steps: [
      "Empaqueta los artículos en su envoltorio original.",
      "Escribe tu número de pedido en el exterior del paquete.",
      "Envíalo a la dirección de abajo con el transportista que elijas.",
      "Vuelve al portal y dinos el transportista y el número de seguimiento.",
    ],
    addressTitle: "Dirección de envío:",
    trackingCta: "Enviar mi número de seguimiento",
    // The link lands on `/[id]`, which redirects to the lookup form without a
    // live portal session — and ORDER_SESSION_TTL_MS is 2 hours. This email is
    // read AFTER the post office, and the day-3 reminder is by construction
    // ~72h after the session was issued, so the customer will be asked to
    // identify themselves essentially every time. Saying so beforehand is the
    // difference between "log in again" and "this link is broken".
    linkNote:
      "Te pediremos tu número de pedido y tu email para identificarte — es el mismo email al que te hemos enviado este mensaje.",
    trackingWhy:
      "Sin el número de seguimiento no podemos avisar al almacén de que tu paquete está en camino, y tu reembolso puede retrasarse.",
    customs:
      "<strong>Si envías desde fuera de la Unión Europea</strong>, el paquete pasará por aduanas y la documentación corre de tu cuenta. Un envío mal declarado puede quedarse retenido o devolverse, y esos gastos no los podemos cubrir.",
    reminderIntro:
      "Hace unos días creaste una devolución para enviarla por tu cuenta y todavía no nos has dicho el número de seguimiento.",
    contact: "Si tienes alguna pregunta, no dudes en contactarnos en",
    signoff:
      "Saludos cordiales,<br/><strong>El equipo de Shameless Collective</strong>",
  },
  en: {
    subject: "Your return: send it whenever you like",
    reminderSubject: "Have you sent your return yet?",
    text: "Your return has been created. Send it with any carrier you like.",
    greeting: (name: string) => `Hello <strong>${name}</strong>,`,
    intro:
      "You chose to ship your return yourself, so <strong>there is no label attached</strong> — you arrange the shipment, with whichever carrier you prefer.",
    stepsTitle: "Steps to complete your return:",
    steps: [
      "Pack the items in their original wrapping.",
      "Write your order number on the outside of the parcel.",
      "Send it to the address below with the carrier of your choice.",
      "Come back to the portal and tell us the carrier and tracking number.",
    ],
    addressTitle: "Shipping address:",
    trackingCta: "Send us my tracking number",
    // See the Spanish note above.
    linkNote:
      "We will ask for your order number and email to identify you — the same email address this message was sent to.",
    trackingWhy:
      "Without the tracking number we cannot tell the warehouse your parcel is on its way, and your refund may be delayed.",
    customs:
      "<strong>If you are shipping from outside the European Union</strong>, the parcel will pass through customs and the paperwork is yours to arrange. A badly declared shipment can be held or returned, and we cannot cover those costs.",
    reminderIntro:
      "A few days ago you created a return to ship yourself, and we still do not have a tracking number for it.",
    contact: "If you have any questions, contact us at",
    signoff: "Best regards,<br/><strong>The Shameless Collective team</strong>",
  },
} as const;

/** `portalUrl` is the absolute base URL of the portal, passed in by the caller
 *  so this module never reads `process.env` — see the module header. */
function selfReturnLink(orderId: string, portalUrl: string): string {
  return `${portalUrl}/${orderId}`;
}

function selfReturnShell(
  c: (typeof SELF_COPY)[Locale],
  name: string,
  orderId: string,
  portalUrl: string,
  intro: string
): string {
  const p = 'style="font-size: 16px; color: #555;"';
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 20px auto;">
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="cid:embedded-image" alt="Shameless Collective Logo" style="max-width: 400px; height: auto;"/>
      </div>
      <div>
        <p ${p}>${c.greeting(name)}</p>
        <p ${p}>${intro}</p>
        <p ${p}>${c.stepsTitle}</p>
        <ol style="font-size: 16px; color: #555; margin-left: 20px; padding-left: 10px;">
          ${c.steps.map((s) => `<li style="margin-bottom: 10px;">${s}</li>`).join("")}
        </ol>
        <p ${p}><strong>${c.addressTitle}</strong><br/>${WAREHOUSE_ADDRESS}</p>
        <p ${p}>
          <a href="${selfReturnLink(orderId, portalUrl)}" style="color: #0073e6;">${c.trackingCta}</a>
        </p>
        <p ${p}>${c.linkNote}</p>
        <p ${p}>${c.trackingWhy}</p>
        <p ${p}>${c.customs}</p>
        <p ${p}>${c.contact}
          <a href="mailto:${FROM}" style="color: #0073e6; text-decoration: none;">${FROM}</a>.
        </p>
        <p ${p}>${c.signoff}</p>
      </div>
    </div>
  `;
}

export function buildSelfReturnInstructionsEmail(
  name: string,
  locale: Locale,
  orderId: string,
  portalUrl: string
): EmailPayload {
  const c = SELF_COPY[locale];
  return {
    From: FROM,
    To: "",
    Subject: c.subject,
    TextBody: c.text,
    HtmlBody: selfReturnShell(c, name, orderId, portalUrl, c.intro),
  };
}

export function buildSelfReturnReminderEmail(
  name: string,
  locale: Locale,
  orderId: string,
  portalUrl: string
): EmailPayload {
  const c = SELF_COPY[locale];
  return {
    From: FROM,
    To: "",
    Subject: c.reminderSubject,
    TextBody: c.reminderIntro,
    HtmlBody: selfReturnShell(c, name, orderId, portalUrl, c.reminderIntro),
  };
}
