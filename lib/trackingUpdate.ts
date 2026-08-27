/**
 * Deciding whether a parcel's carrier status is worth an email.
 *
 * Pure — no db, no network, no clock, no env. Every input is passed in, because
 * this function is the only thing between an hourly poller and a customer's
 * inbox, and the difference between "useful" and "spam" is entirely in here.
 *
 * The rule the whole feature turns on: Correos answers HTTP 200 with
 * `error.codError = "3"` and every field null for a parcel it cannot trace —
 * 82 of 415 live locators were in that state at one point. `parseCorreosTracking`
 * already collapses that to `sin_informacion`. Treating it as a STATE rather
 * than as ABSENCE would email the customer that we had lost their return, then
 * email again when it reappeared.
 */
import type { TrackingPhase } from "@/lib/trackingStatus";

export type TrackingKey = "accepted" | "in_transit" | "received" | "problem";

export type TrackingUpdateInput = {
  lastKey: string | null;
  lastLocator: string | null;
  currentLocator: string | null;
  phase: TrackingPhase;
};

export type TrackingUpdateDecision = {
  notify: TrackingKey | null;
  persist: { lastTrackingKey: TrackingKey; lastTrackingLocator: string } | null;
};

/**
 * Which notification a carrier phase deserves, if any.
 *
 * `en_transito` and `en_reparto` deliberately share one key. Otherwise a parcel
 * moving depot -> depot -> out-for-delivery emails three times, and "out for
 * delivery" is a strange thing to tell someone about a parcel travelling AWAY
 * from them.
 *
 * `prerregistrado` and `sin_informacion` have no key: neither is news.
 */
export function keyForPhase(phase: TrackingPhase): TrackingKey | null {
  switch (phase) {
    case "admitido":
      return "accepted";
    case "en_transito":
    case "en_reparto":
      return "in_transit";
    case "entregado":
      return "received";
    case "incidencia":
      return "problem";
    default:
      return null;
  }
}

/** How far along the journey each key sits. `problem` is 0 so that a parcel
 *  which recovers can still announce that it arrived. */
const RANK: Record<TrackingKey, number> = {
  problem: 0,
  accepted: 1,
  in_transit: 2,
  received: 3,
};

const NOTHING: TrackingUpdateDecision = { notify: null, persist: null };

export function decideTrackingUpdate(
  input: TrackingUpdateInput
): TrackingUpdateDecision {
  const locator = input.currentLocator?.trim();
  if (!locator) return NOTHING;

  const key = keyForPhase(input.phase);
  if (!key) return NOTHING;

  // A different locator is a different parcel: its journey starts over, and
  // whatever the previous one had reached is irrelevant.
  const sameParcel = input.lastLocator?.trim() === locator;
  const lastKey = sameParcel ? (input.lastKey as TrackingKey | null) : null;

  if (key === "problem") {
    // A problem may interrupt at any point, but is worth saying once.
    if (lastKey === "problem") return NOTHING;
  } else if (lastKey && RANK[key] <= (RANK[lastKey] ?? -1)) {
    // Never notify backwards. Correos flapping must not tell a customer their
    // delivered parcel is travelling again.
    return NOTHING;
  }

  return {
    notify: key,
    persist: { lastTrackingKey: key, lastTrackingLocator: locator },
  };
}
