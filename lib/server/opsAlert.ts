import "server-only";
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
// Importers must be server-side modules only (actions, lib, API routes) —
// never a client component. The list of importers is deliberately not
// maintained here; check with grep before relying on it.

import axios from "axios";
import { describeError } from "@/lib/describeError";
import { postmarkEnv, ServiceNotConfigured } from "./serviceEnv";

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
 * Best effort: never throws, and a failure — including an environment with
 * no Postmark — is logged, not swallowed. It is already the fallback path. For
 * an alert that must not be lost, enqueue it with `enqueueOpsAlert`
 * (lib/server/opsAlertOutbox.ts) instead.
 */
export async function alertOps(subject: string, body: string): Promise<void> {
  console.error(`[ops] ${subject}: ${body}`);

  const result = await sendOpsAlert(subject, body);
  if (!result.ok) console.error(`Could not send ops alert (${result.reason}):`, result.error);
}

/** Why an ops email was not accepted. `not-configured`: this environment has
 *  no Postmark, nothing was sent. `rejected`: Postmark refused it or could not
 *  be reached. Either way the outbox keeps the row pending. */
export type OpsAlertSendResult =
  | { ok: true }
  | { ok: false; reason: "not-configured" | "rejected"; error: string };

/**
 * Send one ops email and say whether Postmark accepted it. Same transport as
 * `alertOps`, but the caller learns the outcome, which the outbox needs to
 * decide whether a row is delivered. Never throws.
 *
 * Accepted means HTTP 2xx AND `ErrorCode: 0` in the body: Postmark reports some
 * rejections with a non-zero ErrorCode, and a 200 is not, on its own, proof.
 */
export async function sendOpsAlert(subject: string, body: string): Promise<OpsAlertSendResult> {
  let token: string;
  try {
    token = postmarkEnv().serverToken;
  } catch (error) {
    if (error instanceof ServiceNotConfigured) return { ok: false, reason: "not-configured", error: error.message };
    return { ok: false, reason: "rejected", error: describeError(error) };
  }

  try {
    const response = await axios.post(
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
        // This sits on the charge path (createStripeUrl awaits it before
        // sessions.create), and it is best-effort — a failure here must never
        // block or alter a charge. Without a timeout, axios waits
        // indefinitely, so a hung Postmark stalls the charge itself. A few
        // seconds is enough for a real request to complete; anything longer
        // is Postmark being down, which the catch below already handles.
        timeout: 5000,
      }
    );
    if (response.data?.ErrorCode !== 0) {
      return { ok: false, reason: "rejected", error: `Postmark ErrorCode ${response.data?.ErrorCode}: ${response.data?.Message ?? ""}` };
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, reason: "rejected", error: describeError(error) };
  }
}
