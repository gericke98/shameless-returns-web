import { NextResponse } from "next/server";
import axios from "axios";
import { eq } from "drizzle-orm";
import db from "@/db/drizzle";
import { orders as ordersTable } from "@/db/schema";
import { getParcelsAwaitingTracking } from "@/db/queries";
import { obtainLastStatus } from "@/actions/shipping";
import { decideTrackingUpdate } from "@/lib/trackingUpdate";
import { buildTrackingUpdateEmail } from "@/lib/emails";
import { isInternationalOrder } from "@/lib/countries";
import { tracksWithCorreos } from "@/lib/trackingStatus";
import { readLocale } from "@/lib/i18n";
import { alertOps } from "@/actions/opsAlert";

/**
 * Tell customers where their return has got to.
 *
 * A customer books a return, gets a label, and then hears nothing — for a
 * domestic return that is literally one email at booking and silence after.
 * This closes that gap by reading Correos daily and emailing on milestones.
 *
 * DOMESTIC ONLY. International parcels are already polled every 15 minutes by
 * `amphora-sync`, which owns their notifications; doing it here too would
 * double-send.
 *
 * DRY BY DEFAULT: `TRACKING_EMAILS_ENABLED` must be exactly "true" before a
 * single message goes out, so deploying this route mails nobody.
 *
 * NO `problem` MILESTONE HERE, deliberately. `problem` is international-only
 * today: `lib/trackingStatus.ts` has no pattern that yields the `incidencia`
 * phase, because we have never captured a real Correos incident payload, and
 * `parseCorreosTracking` refuses to guess at a wording it does not recognise.
 * A branch fed by a phase that cannot occur is dead code that reads as
 * coverage, so it is not here. Amphora names its exception states explicitly,
 * which is why `lib/amphoraWebhook.ts` can and does send that email. To close
 * the gap, capture the localizador response for a real incident first, add the
 * pattern in `trackingStatus.ts`, and the milestone lights up here on its own —
 * `decideTrackingUpdate` and `buildTrackingUpdateEmail("problem", ...)` already
 * handle it.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const POSTMARK_API_URL = "https://api.postmarkapp.com/email";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret =
 *  closed, never open — this route emails customers. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Empty and whitespace fall back, because `Number("")` is 0 and a cap of zero
 *  or a silent default is not what an operator who left a box blank meant. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function sendEmail(payload: Record<string, unknown>): Promise<number> {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return 500;
  try {
    const res = await axios.post(POSTMARK_API_URL, payload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
      },
    });
    return res.status;
  } catch (error: any) {
    console.error("[tracking-sync] email error:", error?.response?.data || error?.message);
    return 500;
  }
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryParam = url.searchParams.get("dry");
  const dry =
    (dryParam !== null && dryParam !== "0" && dryParam !== "false") ||
    process.env.TRACKING_EMAILS_ENABLED !== "true";
  // Sized for a DAILY sweep, not an hourly one. The cap is per RUN, so the
  // cadence sets what it costs: at hourly it bounded a spike and the next run
  // was an hour away, at daily a truncated run strands people for 24 hours.
  // The sweep is ordered oldest-first, so an under-sized cap starves the
  // NEWEST parcels — the live ones — every single day, while alerting ops
  // about it every single day.
  //
  // 60 is set against measured demand, not guessed: the backlog at arming was
  // 33 in one run, and `getParcelsAwaitingTracking` had 84 domestic parcels to
  // offer, which is the most any single run can ever want. So 60 clears real
  // demand with room, and still trips well before "every parcel got emailed",
  // which is the anomaly the cap exists to catch.
  const cap = intEnv("TRACKING_MAX_EMAILS_PER_RUN", 60);

  // Record where every parcel already is, WITHOUT telling anyone.
  //
  // Run once before enabling the job. Without it the first live run sees every
  // parcel with no recorded state and treats its CURRENT position as fresh
  // news — telling customers their parcel was accepted by the carrier three
  // weeks ago. The per-run cap turns that from ~40 wrong emails into 20; this
  // makes it zero.
  //
  // It lives here rather than in a script because `db/queries.ts` and
  // `actions/shipping.ts` both import React's `cache()`, so neither the parcel
  // list nor the Correos lookup is reachable from a plain node process.
  //
  // SEEDS `accepted` AND `in_transit` ONLY. The ~36 parcels already sitting
  // delivered are left unseeded on purpose: they are the exact people this
  // feature exists for — unsettled, delivered, and never told — so `received`
  // is allowed to fire for them on the first live run.
  //
  // Parsed like `dry`, not as `=== "1"`. `?seed=true` used to perform a normal
  // run, which once enabled is a live email burst — a dangerous flag must not
  // fail open into the dangerous direction.
  const seedParam = url.searchParams.get("seed");
  const seed =
    seedParam !== null && seedParam !== "0" && seedParam !== "false";

  // Bail before the loop, not inside it. `sendEmail` returns 500 without
  // attempting anything when the token is absent — so without this check a
  // single run would persist every parcel's milestone, mail nobody, and report
  // `notified: N` as though it had. Those milestones can never be re-sent.
  // Seeding never sends, so it does not need a Postmark token to run.
  if (!dry && !seed && !process.env.POSTMARK_SERVER_TOKEN) {
    console.error("[tracking-sync] POSTMARK_SERVER_TOKEN is not set — refusing to run");
    return NextResponse.json({ error: "Email not configured" }, { status: 503 });
  }

  const parcels = (await getParcelsAwaitingTracking()) as any[];
  const total = parcels.length;

  let considered = 0;
  let scanned = 0;
  let notified = 0;
  let seeded = 0;
  let skipped = 0;
  // No readable status came back: the lookup threw, or Correos answered with
  // no traceability. Reported because `scanned: 82, notified: 0` otherwise
  // means both "a quiet hour" and "Correos was down for the whole run".
  let lookupFailures = 0;
  let capped = false;

  for (const order of parcels) {
    if (notified >= cap) {
      capped = true;
      // A dry run is an operator's pre-flight; truncating it hides the rest of
      // the blast radius, which is the one thing the preview is for. Seeding is
      // exempt too, but reaches this at all only because it never increments
      // `notified` — a HALF-seeded database is worse than an unseeded one.
      if (!dry) break;
    }

    considered += 1;

    // International parcels belong to amphora-sync. Notifying here as well
    // would send two emails for one milestone.
    if (isInternationalOrder(order.shippingCountry)) {
      skipped += 1;
      continue;
    }

    // `orders.locator` is overloaded: a SELF return stores the customer's own
    // SEUR/MRW/GLS/FEDEX reference there. Handing one of those to the Correos
    // localizador returns "no traceability" — indistinguishable from a parcel
    // Correos has genuinely lost — so every other Correos caller in this repo
    // guards on the carrier NAME. This one filtered on country alone, which
    // also let a row with a blank `shippingCountry` through.
    if (!tracksWithCorreos(order.carrier)) {
      skipped += 1;
      continue;
    }

    scanned += 1;

    try {
      const status = await obtainLastStatus(order.locator);
      // `obtainLastStatus` swallows its own network errors and answers
      // "unknown", so this — not the catch below — is what a Correos outage
      // actually looks like from here.
      if (status.phase === "sin_informacion") lookupFailures += 1;
      const decision = decideTrackingUpdate({
        lastKey: order.lastTrackingKey ?? null,
        lastLocator: order.lastTrackingLocator ?? null,
        currentLocator: order.locator ?? null,
        phase: status.phase,
      });

      if (!decision.notify || !decision.persist) continue;

      if (seed) {
        // Everything EXCEPT `received`. Recording `received` here is what would
        // silently suppress the backlog this feature was built for: ~36 parcels
        // are already delivered and their customers were never told, and a seed
        // that writes their final milestone means they never will be. Leaving
        // the row unseeded lets the first live run say the one thing they are
        // owed. Nothing earlier can then fire for them — `received` outranks
        // every other key — so this costs no stale news.
        if (decision.persist.lastTrackingKey === "received") continue;

        // Persist, never notify. The cap does not apply: a partial seed is
        // worse than none, because the parcels it missed would still be told
        // stale news on the first live run.
        await db
          .update(ordersTable)
          .set(decision.persist)
          .where(eq(ordersTable.id, order.id));
        seeded += 1;
        continue;
      }

      notified += 1;
      if (dry) {
        console.log(
          `[tracking-sync] WOULD notify ${order.orderNumber}: ${decision.notify}`
        );
        continue;
      }

      // Persist BEFORE emailing. The next daily run then finds the key
      // unchanged and does nothing, so nobody can be told twice. The cost is
      // that a failed send is not retried — hence the loud log below.
      await db
        .update(ordersTable)
        .set(decision.persist)
        .where(eq(ordersTable.id, order.id));

      const built = buildTrackingUpdateEmail(
        decision.notify,
        order.shippingName,
        readLocale(order.locale)
      );
      const status_ = await sendEmail({
        ...built,
        To: order.email,
        MessageStream: "outbound",
      });
      if (status_ !== 200) {
        console.error(
          `[tracking-sync] ${order.orderNumber}: state saved as ${decision.notify} but the email FAILED (${status_}). Customer needs a manual notice.`
        );
        // The state is already written, so this milestone will never be
        // retried — the next run finds the key unchanged and does nothing.
        // A log line is not a record anyone will find tomorrow.
        await alertOps(
          `[returns] TRACKING EMAIL NOT SENT — order ${order.orderNumber}`,
          [
            `The "${decision.notify}" notice for ${order.orderNumber} was recorded but the email FAILED (HTTP ${status_}).`,
            `Because the state is saved first, this milestone will NOT be retried automatically.`,
            `Customer: ${order.email}`,
            `Parcel: ${order.locator}`,
            `Send them a manual notice, or clear last_tracking_key on the order to let the next run resend.`,
          ].join("\n")
        );
      }

    } catch (error: any) {
      lookupFailures += 1;
      // One parcel must not stop the sweep — the rest are still owed their news.
      console.error(
        `[tracking-sync] ${order.orderNumber} failed:`,
        error?.message || error
      );
    }
  }

  const remaining = total - considered;

  // Report the mode, not the flag. Seeding WRITES; an operator reading
  // `dry: true` on a run that persisted 40 rows would conclude the opposite.
  const mode = seed ? "seed" : dry ? "dry" : "live";

  // Both alerts are live-only. This route spends most of its life dry by
  // design, so alerting from a dry run would mean a daily ops email about a
  // job that is deliberately doing nothing. The counters in the
  // response body are how a dry run reports the same facts.
  if (!dry && !seed) {
    if (capped) {
      await alertOps(
        `[returns] TRACKING SWEEP TRUNCATED — ${remaining} parcels not reached`,
        [
          `The daily tracking sweep stopped at the per-run cap of ${cap} emails.`,
          `Reached ${considered} of ${total} parcels; ${remaining} were not looked at.`,
          `The sweep is ordered oldest-first, so the SAME parcels are skipped every`,
          `day until the backlog clears — the newest ones are the live parcels.`,
          `Raise TRACKING_MAX_EMAILS_PER_RUN, or check why so many milestones landed at once.`,
        ].join("\n")
      );
    }
    // A ratio needs a sample. `sin_informacion` is the honest answer for a
    // parcel Correos has not scanned yet, so on a quiet hour two fresh parcels
    // are 2 of 2 — a worse ratio than any real outage produces — and this
    // would page ops every hour about a working system. The threshold is the
    // SHAPE of an outage; the floor is what makes it evidence. Measured
    // baseline: 82 of 415 live locators untraceable, ~20%, so half remains the
    // right threshold once the sample is large enough to mean anything.
    const MIN_SAMPLE = 10;
    if (scanned >= MIN_SAMPLE && lookupFailures * 2 > scanned) {
      await alertOps(
        `[returns] TRACKING LOOKUPS FAILING — ${lookupFailures}/${scanned}`,
        [
          `${lookupFailures} of ${scanned} Correos lookups returned nothing readable this run.`,
          `That is more than half, which looks like the localizador being down or`,
          `rejecting our credentials rather than a quiet hour.`,
          `Nobody was emailed for those parcels, and nothing was persisted, so the`,
          `next run will retry them — but a persistent failure means customers are`,
          `silently getting no tracking notices at all.`,
        ].join("\n")
      );
    }
  }

  return NextResponse.json({
    total,
    remaining,
    scanned,
    notified,
    seeded,
    skipped,
    lookupFailures,
    capped,
    mode,
    dry: mode === "dry",
  });
}
