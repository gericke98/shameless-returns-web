import "server-only";
// NOT "use server": every export of such a module is a public endpoint, and
// these send our email to whatever address the caller passes. Only server
// code imports them (selfBookedReturn, selfReturnSweep, selfTrackingReview).

// Postmark transport for the self-booked-return lane. `lib/emails.ts` stays
// pure (no I/O, no env) — this module owns the axios POST, the token check,
// and the inline logo attachment, mirroring `sendEmail` in `actions/shipping.ts`.
//
// Unlike the Correos lane, there is no PDF attachment here: the customer books
// their own courier, so there is no label to send.
import axios from "axios";
import { base64img } from "@/placeholder";
import {
  buildSelfReturnInstructionsEmail,
  buildSelfReturnReminderEmail,
  buildSelfTrackingRejectedEmail,
  type EmailPayload,
} from "@/lib/emails";
import type { Locale } from "@/lib/i18n";
import { appEnv, postmarkEnv, ServiceNotConfigured } from "./serviceEnv";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

async function sendSelfReturnEmail(
  payload: EmailPayload,
  to: string
): Promise<number> {
  try {
    // Inside the try: an environment with no Postmark is logged below and
    // reported as a failed send, never skipped in silence.
    const token = postmarkEnv().serverToken;
    const res = await axios.post(
      POSTMARK_API_URL,
      {
        ...payload,
        To: to,
        MessageStream: "outbound",
        Attachments: [
          {
            Name: "mail.jpg",
            Content: base64img,
            ContentType: "image/jpeg",
            ContentID: "embedded-image",
          },
        ],
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
    return res.status;
  } catch (error: any) {
    console.error(
      "Self-return email error:",
      error?.response?.data || error?.message || error
    );
    return 500;
  }
}

/**
 * Build the email with this deployment's portal URL and send it. Without the
 * URL the email is not sent — a link to "" is a broken email — and the refusal
 * is logged and reported as a failed send, like any other.
 */
async function sendWithPortalUrl(
  to: string,
  build: (portalUrl: string) => EmailPayload
): Promise<number> {
  let portalUrl: string;
  try {
    portalUrl = appEnv().publicUrl;
  } catch (error) {
    if (!(error instanceof ServiceNotConfigured)) throw error;
    console.error(`Self-return email not sent: ${error.message}`);
    return 500;
  }
  return sendSelfReturnEmail(build(portalUrl), to);
}

export async function sendSelfReturnInstructions(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  return sendWithPortalUrl(to, (portalUrl) =>
    buildSelfReturnInstructionsEmail(name, locale, orderId, portalUrl)
  );
}

export async function sendSelfReturnReminder(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  return sendWithPortalUrl(to, (portalUrl) =>
    buildSelfReturnReminderEmail(name, locale, orderId, portalUrl)
  );
}

export async function sendSelfTrackingRejected(
  to: string,
  name: string,
  locale: Locale,
  orderId: string,
  number: string
): Promise<number> {
  return sendWithPortalUrl(to, (portalUrl) =>
    buildSelfTrackingRejectedEmail(name, locale, orderId, portalUrl, number)
  );
}
