"use server";

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
  type EmailPayload,
} from "@/lib/emails";
import type { Locale } from "@/lib/i18n";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

async function sendSelfReturnEmail(
  payload: EmailPayload,
  to: string
): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;

  try {
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

export async function sendSelfReturnInstructions(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  const portalUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return sendSelfReturnEmail(
    buildSelfReturnInstructionsEmail(name, locale, orderId, portalUrl),
    to
  );
}

export async function sendSelfReturnReminder(
  to: string,
  name: string,
  locale: Locale,
  orderId: string
): Promise<number> {
  const portalUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return sendSelfReturnEmail(
    buildSelfReturnReminderEmail(name, locale, orderId, portalUrl),
    to
  );
}
