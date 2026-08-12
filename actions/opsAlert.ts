// DELIBERATELY NOT a server action, and it must never be imported by a client
// component — importing it from one is what would force `"use server"` back on.
//
// The directive published `alertOps` in Next's server-action manifest, i.e. an
// unauthenticated POST endpoint taking attacker-controlled `subject` and
// `body` and emailing them to our own ops address. The alerts it sends are
// instructions to a human to refund a customer by hand, so a forged one is a
// phishing message arriving from us, in the exact format ops is trained to act
// on — and enough of them buries the real ones.
//
// Verified before removing: the only importer is `actions/cancelReturn.ts`
// (a server module).

import axios from "axios";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";
const OPS_ADDRESS = "hello@shamelesscollective.com";

/**
 * Tell a human something needs fixing, durably.
 *
 * Vercel keeps runtime logs for about an hour, so `console.error` is not a
 * record that anyone will find tomorrow — a production freeze went unnoticed
 * for nine days behind exactly that assumption. Cancellation compounds it: the
 * row is cleared moments later, which drops it out of the dashboard too, so
 * the inbox becomes the only place the problem still exists.
 *
 * Best effort and silent on failure. It is already the fallback path.
 */
export async function alertOps(subject: string, body: string): Promise<void> {
  console.error(`[ops] ${subject}: ${body}`);

  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return;

  try {
    await axios.post(
      POSTMARK_API_URL,
      {
        From: OPS_ADDRESS,
        To: OPS_ADDRESS,
        Subject: subject,
        TextBody: body,
        MessageStream: "outbound",
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
      }
    );
  } catch (error: any) {
    console.error("Could not send ops alert:", error?.response?.data || error?.message);
  }
}
