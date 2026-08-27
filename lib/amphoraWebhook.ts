// Pure — no db, no env, no network. Decides what a return-status webhook should
// change and which emails it should trigger, so the whole matrix is testable
// without constructing an HTTP request.
//
// Amphora spells approved `APROVED`, with one P. That is the wire value.
import { amphoraTrackingStatus } from "@/lib/trackingStatus";
import { decideTrackingUpdate, type TrackingKey } from "@/lib/trackingUpdate";

/**
 * Recorded when Amphora hands us a tracking number without naming the carrier.
 *
 * Must NOT contain "correos": `tracksWithCorreos` treats a null carrier as our
 * own domestic Correos label, and this value exists precisely to avoid
 * inheriting that meaning. Pinned by a test in tests/amphoraWebhook.test.ts.
 */
export const UNKNOWN_CARRIER = "UNKNOWN";

export type AmphoraWebhookReturn = {
  id?: string | null;
  name?: string | null;
  internal_status?: string | null;
  carrier?: string | null;
  carrier_number?: string | null;
  carrier_url?: string | null;
};

export type WebhookEmail =
  | "collectionScheduled"
  | "returnReceived"
  | "trackingInTransit"
  | "trackingProblem";

export type WebhookActions = {
  noop: boolean;
  persist: {
    locator?: string;
    carrier?: string;
    carrierUrl?: string;
    returnStatus: string;
    /** Written by the same rank table the domestic sweep uses, so a status
     *  that flaps cannot re-announce a milestone. See below. */
    lastTrackingKey?: TrackingKey;
    lastTrackingLocator?: string;
  } | null;
  emails: WebhookEmail[];
};

const NOOP: WebhookActions = { noop: true, persist: null, emails: [] };

/**
 * Our order id, recovered from Amphora's return id.
 *
 * The webhook payload carries no `external_id` — unlike every other Amphora
 * record we handle — so this prefix is the only direct link back. Callers must
 * fall back to matching `name` against `orders.orderNumber` when this is null.
 */
export function orderIdFromWebhook(
  payload: AmphoraWebhookReturn
): string | null {
  const id = payload.id?.trim();
  if (!id?.startsWith("SHP ")) return null;
  return id.slice(4).trim() || null;
}

/**
 * What a status event should change, and who should hear about it.
 *
 * Returns `noop` for anything we have already acted on. Amphora retries, so
 * this is what stands between a redelivered event and a duplicate email landing
 * in a customer's inbox.
 */
export function decideWebhookActions(
  order: {
    returnStatus?: string | null;
    locator?: string | null;
    /** Optional so the callers that predate the tracking columns keep
     *  compiling; absent simply means "no milestone recorded yet". */
    lastTrackingKey?: string | null;
    lastTrackingLocator?: string | null;
  },
  payload: AmphoraWebhookReturn
): WebhookActions {
  const status = payload.internal_status?.trim();
  if (!status) return NOOP;

  if (order.returnStatus === status) return NOOP;

  const persist: NonNullable<WebhookActions["persist"]> = {
    returnStatus: status,
  };
  // Only ever ADD tracking. A later event that omits the carrier must not wipe
  // tracking we already hold.
  if (payload.carrier_number) persist.locator = payload.carrier_number;
  if (payload.carrier) {
    persist.carrier = payload.carrier;
  } else if (payload.carrier_number && !order.locator) {
    // Amphora is INTRODUCING a tracking number and did not say whose it is.
    //
    // Leaving `carrier` null would be a lie: null does not mean "unknown", it
    // means "our own domestic Correos label", and that is what gates the
    // Correos tracking lookup. The localizador would then be asked about a
    // carrier code it has never held, answer "no traceability", and the cancel
    // gate — which fails closed — would block this customer permanently.
    //
    // `!order.locator` is what makes this safe for the domestic lane: there we
    // write the Correos code ourselves BEFORE Amphora ever polls, so a later
    // echo of that same number finds a locator already present and leaves the
    // null carrier untouched. Only a genuinely new, Amphora-supplied number
    // reaches this branch.
    persist.carrier = UNKNOWN_CARRIER;
  }
  if (payload.carrier_url) persist.carrierUrl = payload.carrier_url;

  const emails: WebhookEmail[] = [];
  // Keyed off tracking ARRIVING, not off a particular status: the carrier may
  // first appear on APROVED or on TRAVELLING, and which one it is varies.
  if (payload.carrier_number && !order.locator) {
    emails.push("collectionScheduled");
  }
  if (status === "RECEIVED") emails.push("returnReceived");

  // The two milestones the international lane never had, decided by the SAME
  // rank table the domestic sweep uses rather than by "the status changed".
  //
  // Status-change alone is a safe dedupe for a monotonic lifecycle, and the
  // Amphora lifecycle is not one where it matters most: TRAVELLING ->
  // EXCEPTION_HOLD -> TRAVELLING is an ordinary customs hold, `amphora-sync`
  // polls every 15 minutes, and each leg of that oscillation is a status
  // change. Nothing bounded it, so one held parcel could email its customer
  // "on its way" and "there is a problem" alternately, all day.
  //
  // `decideTrackingUpdate` is the fix: it remembers HOW FAR the parcel got, not
  // just where it was last seen, and refuses to walk a customer backwards.
  const phase = amphoraTrackingStatus(status).phase;
  const tracking = decideTrackingUpdate({
    lastKey: order.lastTrackingKey ?? null,
    lastLocator: order.lastTrackingLocator ?? null,
    // `carrier_number` first: on the event that introduces tracking it is the
    // parcel's identity, and `order.locator` has not been written yet.
    currentLocator: payload.carrier_number ?? order.locator ?? null,
    phase,
  });

  // `accepted` and `received` are deliberately dropped: `collectionScheduled`
  // and `returnReceived` above already own those two moments, and a parallel
  // email would send two messages for one milestone. The KEY is still
  // persisted for them, which is what keeps the rank monotonic.
  //
  // The `collectionScheduled` guard survives unchanged: that email carries the
  // tracking number and URL and already says the parcel is moving, and the
  // carrier can first appear on TRAVELLING — without this, one customer gets
  // two emails in the same second describing one milestone.
  if (tracking.notify === "in_transit" && !emails.includes("collectionScheduled")) {
    emails.push("trackingInTransit");
  }
  if (tracking.notify === "problem") {
    emails.push("trackingProblem");
  }
  if (tracking.persist) {
    persist.lastTrackingKey = tracking.persist.lastTrackingKey;
    persist.lastTrackingLocator = tracking.persist.lastTrackingLocator;
  }

  return { noop: false, persist, emails };
}
