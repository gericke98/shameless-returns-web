import "server-only";
// The one cron credential check (F1 spec §6). Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET`. An unset secret refuses every request,
// so a missing env var never opens the job to the internet.
import { createHash, timingSafeEqual } from "crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** True when the request carries exactly `Bearer $CRON_SECRET`. Constant-time. */
export function verifyCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const sent = req.headers.get("authorization") ?? "";
  // Compare fixed-length digests: `timingSafeEqual` needs equal lengths, and
  // hashing first means the length of the secret leaks nothing either.
  return timingSafeEqual(digest(sent), digest(`Bearer ${secret}`));
}
