// Pure — the carriers a customer may pick when shipping a return themselves.
//
// A fixed list rather than free text, for two reasons: it gives us a real
// tracking URL to store, and it gives `tracksWithCorreos` a value it can reason
// about. "corros" in the warehouse's records helps nobody.

/**
 * Where a carrier's tracking link comes from. Amphora's approve requires a
 * `carrier_url`, and it is pinned write-once with the tracking number, so
 * every carrier must have a real answer:
 *  - "built": we build it from the tracking number;
 *  - "customer": we cannot, so the customer must give it ("Other").
 * "Other" used to build `""`, a required field left empty, and the approvals
 * for #312783 / #312737 (2026-11-23) and #311595 failed.
 */
export type CarrierLink =
  | { readonly kind: "built"; readonly build: (trackingNumber: string) => string }
  | { readonly kind: "customer" };

export type CarrierOption = {
  /** Stored in orders.carrier and sent to Amphora as carrier_data.carrier. */
  readonly code: string;
  readonly label: string;
  readonly link: CarrierLink;
};

const built = (build: (trackingNumber: string) => string): CarrierLink => ({
  kind: "built",
  build,
});

export const CARRIERS: readonly CarrierOption[] = Object.freeze([
  {
    code: "CORREOS",
    label: "Correos",
    // Picking Correos is legitimate and works: tracksWithCorreos matches this
    // code, so the dashboard shows real phases exactly as it does for a label
    // we booked ourselves.
    link: built((n) =>
      `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(n)}`),
  },
  {
    code: "SEUR",
    label: "SEUR",
    link: built((n) => `https://www.seur.com/livetracking/?segOnlineIdentificador=${encodeURIComponent(n)}`),
  },
  {
    code: "MRW",
    label: "MRW",
    link: built((n) => `https://www.mrw.es/seguimiento_envios/MRW_seguimiento_envios.asp?modo=nacional&envio=${encodeURIComponent(n)}`),
  },
  {
    code: "GLS",
    label: "GLS",
    link: built((n) => `https://www.gls-spain.es/es/tracking/?match=${encodeURIComponent(n)}`),
  },
  {
    code: "DHL",
    label: "DHL",
    link: built((n) => `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${encodeURIComponent(n)}`),
  },
  {
    code: "UPS",
    label: "UPS",
    link: built((n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`),
  },
  {
    code: "FEDEX",
    label: "FedEx",
    link: built((n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`),
  },
  {
    code: "CTT",
    label: "CTT",
    link: built((n) => `https://www.ctt.pt/particulares/seguimento?objectSearchInput=${encodeURIComponent(n)}`),
  },
  {
    code: "ANPOST",
    label: "An Post",
    link: built((n) => `https://www.anpost.com/Post-Parcels/Track?item=${encodeURIComponent(n)}`),
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
