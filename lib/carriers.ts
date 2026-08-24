// Pure — the carriers a customer may pick when shipping a return themselves.
//
// A fixed list rather than free text, for two reasons: it gives us a real
// tracking URL to store, and it gives `tracksWithCorreos` a value it can reason
// about. "corros" in the warehouse's records helps nobody.

export type CarrierOption = {
  /** Stored in orders.carrier and sent to Amphora as carrier_data.carrier. */
  readonly code: string;
  readonly label: string;
  readonly trackingUrl: (trackingNumber: string) => string;
};

export const CARRIERS: readonly CarrierOption[] = Object.freeze([
  {
    code: "CORREOS",
    label: "Correos",
    // Picking Correos is legitimate and works: tracksWithCorreos matches this
    // code, so the dashboard shows real phases exactly as it does for a label
    // we booked ourselves.
    trackingUrl: (n) =>
      `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${encodeURIComponent(n)}`,
  },
  {
    code: "SEUR",
    label: "SEUR",
    trackingUrl: (n) => `https://www.seur.com/livetracking/?segOnlineIdentificador=${encodeURIComponent(n)}`,
  },
  {
    code: "MRW",
    label: "MRW",
    trackingUrl: (n) => `https://www.mrw.es/seguimiento_envios/MRW_seguimiento_envios.asp?modo=nacional&envio=${encodeURIComponent(n)}`,
  },
  {
    code: "GLS",
    label: "GLS",
    trackingUrl: (n) => `https://www.gls-spain.es/es/tracking/?match=${encodeURIComponent(n)}`,
  },
  {
    code: "DHL",
    label: "DHL",
    trackingUrl: (n) => `https://www.dhl.com/es-es/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  },
  {
    code: "UPS",
    label: "UPS",
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  },
  {
    code: "FEDEX",
    label: "FedEx",
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  },
  {
    code: "CTT",
    label: "CTT",
    trackingUrl: (n) => `https://www.ctt.pt/particulares/seguimento?objectSearchInput=${encodeURIComponent(n)}`,
  },
  {
    code: "ANPOST",
    label: "An Post",
    trackingUrl: (n) => `https://www.anpost.com/Post-Parcels/Track?item=${encodeURIComponent(n)}`,
  },
  {
    code: "OTHER",
    label: "Other",
    // No URL we can build. The dashboard will read `sin_informacion`, which is
    // the honest answer — never invent a status.
    trackingUrl: () => "",
  },
]);

export function carrierByCode(code: string): CarrierOption | null {
  return CARRIERS.find((c) => c.code === code) ?? null;
}
