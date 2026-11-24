// A tracking link a customer typed. Pure, so the browser and the server run the
// same check: the browser to say so before the confirm step, the server
// because the value is pinned at Amphora WRITE-ONCE and a server action is an
// endpoint anyone can call with anything.

/** Generous for real carrier links (the longest we build is ~110 chars). */
export const MAX_TRACKING_URL_LENGTH = 512;

export type TrackingUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: "missing-url" | "invalid-url" };

export function checkTrackingUrl(input: unknown): TrackingUrlCheck {
  if (input === undefined || input === null) return { ok: false, reason: "missing-url" };
  // A server action receives whatever the caller sent: never coerce an
  // object into a link that gets pinned.
  if (typeof input !== "string") return { ok: false, reason: "invalid-url" };
  if (input.trim() === "") return { ok: false, reason: "missing-url" };
  const text = input.trim();
  if (text.length > MAX_TRACKING_URL_LENGTH) return { ok: false, reason: "invalid-url" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  // A web page someone can open: no javascript:, data:, mailto: or file:.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid-url" };
  }
  // A real host name, not "http://tracking" or a bare IP someone guessed.
  if (!url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)) {
    return { ok: false, reason: "invalid-url" };
  }
  return { ok: true, url: url.href };
}
