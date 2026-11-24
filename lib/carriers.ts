// Pure — the carriers a customer may pick when shipping a return themselves.
//
// A fixed list rather than free text, for two reasons: it gives us a real
// tracking URL to store, and it gives `tracksWithCorreos` a value it can reason
// about. "corros" in the warehouse's records helps nobody.

/**
 * Where a carrier's tracking link comes from. Amphora's approve requires a
 * `carrier_url`, and it is pinned write-once with the tracking number, so
 * every carrier must have a real answer:
 *  - "built": we build it from the tracking number. `build` returns null when
 *    the number cannot be one of this carrier's (NACEX numbers are
 *    agency/delivery-note pairs, and the link needs both halves);
 *  - "customer": we cannot, so the customer must give it ("Other").
 * "Other" used to build `""`, a required field left empty, and the approvals
 * for #312783 / #312737 (2026-11-23) and #311595 failed.
 *
 * Every built link below was opened in a browser on 2026-11-24, with a real
 * parcel where one existed (Correos, DHL, CTT, NACEX, Royal Mail, bpost) and a
 * made-up number otherwise, and it lands on that number's tracking. Links that
 * did not (the old CTT, GLS and An Post ones 404'd or dropped the number; DHL
 * lost it on the way to DHL Paket) were replaced; MRW only offers tracking to
 * account holders, so the customer gives its link.
 */
export type CarrierLink =
  | { readonly kind: "built"; readonly build: (trackingNumber: string) => string | null }
  | { readonly kind: "customer" };

export type CarrierOption = {
  /** Stored in orders.carrier and sent to Amphora as carrier_data.carrier. */
  readonly code: string;
  readonly label: string;
  readonly link: CarrierLink;
  /** A number in this carrier's format, shown as the input's placeholder. */
  readonly example?: string;
};

const built = (build: (trackingNumber: string) => string | null): CarrierLink => ({
  kind: "built",
  build,
});

const q = encodeURIComponent;

/**
 * A NACEX reference is the origin agency (4 digits) and the delivery note,
 * written "7280/13972666". Both halves are needed for its tracking page, so a
 * number that does not split into them cannot be a NACEX one we can link.
 */
export function nacexParts(n: string): { agency: string; note: string } | null {
  const m = /^(\d{4})\s*[/-]\s*(\d{5,10})$/.exec(n.trim());
  return m ? { agency: m[1], note: m[2] } : null;
}

export const CARRIERS: readonly CarrierOption[] = Object.freeze([
  {
    code: "CORREOS",
    label: "Correos",
    // Picking Correos is legitimate and works: tracksWithCorreos matches this
    // code, so the dashboard shows real phases exactly as it does for a label
    // we booked ourselves.
    link: built((n) =>
      `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${q(n)}`),
  },
  {
    code: "SEUR",
    label: "SEUR",
    link: built((n) => `https://www.seur.com/livetracking/?segOnlineIdentificador=${q(n)}`),
  },
  {
    code: "NACEX",
    label: "NACEX",
    example: "7280/13972666",
    link: built((n) => {
      const parts = nacexParts(n);
      return parts
        ? `https://www.nacex.es/seguimientoDetalle.do?agencia_origen=${q(parts.agency)}&numero_albaran=${q(parts.note)}&externo=N`
        : null;
    }),
  },
  {
    code: "MRW",
    label: "MRW",
    // MRW's tracking page is for account holders; there is no public link to
    // build, so the customer gives the one MRW sent them.
    link: { kind: "customer" },
  },
  {
    code: "GLS",
    label: "GLS",
    link: built((n) => `https://gls-group.com/ES/es/seguimiento-envio?match=${q(n)}`),
  },
  {
    code: "DHL",
    label: "DHL",
    // The global page with submit=1 follows the number into DHL Paket and
    // DHL Express alike; the es-es page lost it on the way to DHL Paket.
    link: built((n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${q(n)}&submit=1`),
  },
  {
    code: "UPS",
    label: "UPS",
    link: built((n) => `https://www.ups.com/track?tracknum=${q(n)}`),
  },
  {
    code: "FEDEX",
    label: "FedEx",
    link: built((n) => `https://www.fedex.com/fedextrack/?trknbr=${q(n)}`),
  },
  {
    code: "CTT",
    label: "CTT",
    // Opens with the number filled in; CTT itself asks for a captcha before
    // showing results.
    link: built((n) => `https://appserver2.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=${q(n)}`),
  },
  {
    code: "ROYALMAIL",
    label: "Royal Mail",
    link: built((n) => `https://www.royalmail.com/track-your-item#/tracking-results/${q(n)}`),
  },
  {
    code: "BPOST",
    label: "bpost",
    link: built((n) => `https://track.bpost.cloud/btr/web/#/search?itemCode=${q(n)}&lang=en`),
  },
  {
    code: "ANPOST",
    label: "An Post",
    link: built((n) => `https://www.anpost.com/Post-Parcels/Track/History?item=${q(n)}`),
  },
  {
    code: "OTHER",
    label: "Other",
    // No link we can build, so the customer gives it (TrackingCapture
    // requires it; submitReturnTracking validates it). The dashboard still
    // reads `sin_informacion` for this carrier — never invent a status.
    link: { kind: "customer" },
  },
]);

export function carrierByCode(code: string): CarrierOption | null {
  return CARRIERS.find((c) => c.code === code) ?? null;
}

/**
 * Whether a "tracking number" is really the customer's own order reference.
 * Customers type the number they have to hand: #311595 (Oct) and #313127
 * (Nov) sent their order number, and Amphora pinned it as carrier_number,
 * write-once. Compared on letters and digits only, so "#313127", "313127" and
 * " 313-127" all match: punctuation and spacing do not make it a different
 * number. Compared against explicit data (the order's own references), never
 * against words a customer might type around it.
 *
 * STOPGAP, by decision (Santi, 2026-11-24): it refuses the two mistakes seen
 * so far, but cannot prove a number is a real shipment ("Order #313127" still
 * passes). The root fix is to verify the number with the carrier before it is
 * pinned (Correos first; other carriers confirmed by ops), planned next.
 */
export function isOrderReference(
  trackingNumber: string,
  order: { orderNumber?: string | null; id?: string | null }
): boolean {
  const bare = (s: string) => s.replace(/[^0-9a-z]/gi, "").toUpperCase();
  const typed = bare(trackingNumber);
  if (typed === "") return false;
  return [order.orderNumber, order.id].some((ref) => !!ref && bare(ref) === typed);
}

/**
 * Bounded because Amphora pins the value WRITE-ONCE: an unbounded string on an
 * uncorrectable field is not a minor concern. The longest real reference is
 * ~35 characters (UPS 18, DHL 20, Correos 23).
 */
export const MAX_TRACKING_NUMBER_LENGTH = 64;

export type TrackingNumberProblem = "empty-tracking" | "too-long" | "wrong-format" | "order-number";

export type TrackingNumberCheck =
  | {
      ok: true;
      number: string;
      /** The link we build for this carrier, or null where the customer gives it. */
      link: string | null;
    }
  | { ok: false; reason: TrackingNumberProblem };

/**
 * Everything we can know about a tracking number before it is pinned, in one
 * place: the portal runs it as the customer types, and submitReturnTracking
 * runs it again before the write-once claim, so the two cannot disagree about
 * what is refused or why.
 */
export function checkTrackingNumber(
  carrier: CarrierOption,
  raw: unknown,
  order: { orderNumber?: string | null; id?: string | null }
): TrackingNumberCheck {
  // A server action receives whatever the caller sent: never coerce an object
  // or an array into a number that gets pinned.
  if (typeof raw !== "string") return { ok: false, reason: "empty-tracking" };
  const number = raw.trim();
  if (number === "") return { ok: false, reason: "empty-tracking" };
  if (number.length > MAX_TRACKING_NUMBER_LENGTH) return { ok: false, reason: "too-long" };
  if (isOrderReference(number, order)) return { ok: false, reason: "order-number" };
  if (carrier.link.kind === "customer") return { ok: true, number, link: null };
  const link = carrier.link.build(number);
  return link === null ? { ok: false, reason: "wrong-format" } : { ok: true, number, link };
}
