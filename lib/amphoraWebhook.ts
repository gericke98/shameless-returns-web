// Pure — no db, no env, no network. Decides what a return-status webhook should
// change and which emails it should trigger, so the whole matrix is testable
// without constructing an HTTP request.
//
// Amphora spells approved `APROVED`, with one P. That is the wire value.

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
  order: { returnStatus?: string | null; locator?: string | null },
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

  // The two milestones the international lane never had. `collectionScheduled`
  // and `returnReceived` already cover the accepted and received moments, so
  // adding parallel emails there would send two messages for one milestone.
  //
  // Not when `collectionScheduled` is already going out in this same event.
  // That email carries the tracking number and URL and already says the parcel
  // is moving; the carrier can first appear on TRAVELLING (see above), and
  // without this guard that customer would get two emails in the same second
  // describing one milestone.
  if (status === "TRAVELLING" && !emails.includes("collectionScheduled")) {
    emails.push("trackingInTransit");
  }
  if (
    status === "EXCEPTION" ||
    status === "EXCEPTION_WAREHOUSE" ||
    status === "EXCEPTION_HOLD" ||
    status === "FINISHED_REJECTED"
  ) {
    emails.push("trackingProblem");
  }

  return { noop: false, persist, emails };
}
