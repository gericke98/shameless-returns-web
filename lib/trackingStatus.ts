/**
 * Turning a carrier's tracking payload into something the dashboard can both
 * display and filter on.
 *
 * Pure — no network, no database — so the parsing rules can be tested against
 * the payload shapes Correos actually returns rather than the ones we assume.
 *
 * The rule that matters: NEVER invent a status. "Prerregistrado" is a positive
 * claim that Correos holds a label for a parcel the customer has not yet
 * deposited. Saying that about a parcel Correos has no record of asserts the
 * opposite of the truth — and for 82 of 415 live locators it was doing exactly
 * that, on orders delivered months earlier. Absence of data is its own state.
 */

/** Canonical phases. Both the label shown and the filter key derive from these,
 *  so the two can no longer disagree — which is what made the dashboard's
 *  Shipping Status filter match nothing at all. */
export type TrackingPhase =
  | "prerregistrado"
  | "admitido"
  | "en_transito"
  | "en_reparto"
  | "entregado"
  | "incidencia"
  | "sin_informacion";

export type TrackingStatus = {
  /** Human-readable, in the carrier's own words where we have them. */
  label: string;
  phase: TrackingPhase;
};

/** Lowercase, strip accents, drop trailing punctuation and collapse spaces.
 *  Correos sends "Admitido." with a period and "EN TRÁNSITO" in caps; the old
 *  filter compared those against the literal option value "admitido". */
function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ordered because some wordings contain others ("en reparto" vs "reparto"). */
const PHASE_PATTERNS: ReadonlyArray<[RegExp, TrackingPhase]> = [
  [/^entregado/, "entregado"],
  [/^en reparto|^reparto|^a disposicion del destinatario/, "en_reparto"],
  [/^en transito|^en camino|^clasificado|^en tratamiento/, "en_transito"],
  [/^admitido|^depositado/, "admitido"],
  [/^prerregistrado|^pre-?admision/, "prerregistrado"],
];

/**
 * Map a carrier status string onto a canonical phase.
 *
 * Anything unrecognised is `sin_informacion` rather than a guess: an unknown
 * wording must not be silently filed under a phase it may not belong to.
 */
export function trackingPhase(label: string | null | undefined): TrackingPhase {
  if (!label) return "sin_informacion";
  const key = normalise(label);
  if (!key) return "sin_informacion";
  for (const [pattern, phase] of PHASE_PATTERNS) {
    if (pattern.test(key)) return phase;
  }
  return "sin_informacion";
}

/** The only honest answer when we have not learned anything about the parcel —
 *  no traceability, an unreadable payload, or the carrier being unreachable. */
export const UNKNOWN_TRACKING: TrackingStatus = {
  label: "Sin información",
  phase: "sin_informacion",
};

/**
 * Does this order's parcel travel with Correos?
 *
 * Domestic returns store a Correos CodEnvio in `locator` and leave `carrier`
 * null. International ones go through Amphora, which sets `carrier` — and
 * sometimes sets it to "correos" itself, because Amphora subcontracts Correos
 * for some destinations (order #310843 did exactly that, with a valid Correos
 * code). So the test is on the carrier NAME, not on whether one is present.
 *
 * Getting this wrong is the same bug in a new place: asking Correos about a
 * carrier code it has never heard of returns "no traceability", which the old
 * code rendered as "Prerregistrado".
 */
export function tracksWithCorreos(carrier: string | null | undefined): boolean {
  if (!carrier) return true;
  return normalise(carrier).includes("correos");
}

/**
 * Amphora's return lifecycle, mapped onto the same phases as Correos so the
 * dashboard can display and filter both without special-casing.
 *
 * Wire spelling is APROVED — one P. That is Amphora's, not a typo here.
 */
const AMPHORA_PHASES: Record<string, TrackingStatus> = {
  PENDING: { label: "Pendiente de aprobación", phase: "prerregistrado" },
  APROVED: { label: "Recogida programada", phase: "admitido" },
  TRAVELLING: { label: "En tránsito", phase: "en_transito" },
  PROCESSING_WAREHOUSE: { label: "En almacén", phase: "entregado" },
  RECEIVED: { label: "Recibido en almacén", phase: "entregado" },
  FINISHED: { label: "Finalizado", phase: "entregado" },
  FINISHED_REJECTED: { label: "Rechazado", phase: "incidencia" },
  EXCEPTION: { label: "Incidencia", phase: "incidencia" },
  EXCEPTION_WAREHOUSE: { label: "Incidencia en almacén", phase: "incidencia" },
  EXCEPTION_HOLD: { label: "Incidencia (retenido)", phase: "incidencia" },
};

/**
 * Status for an Amphora collection, from the last webhook we received.
 *
 * Null means no webhook has arrived for this order yet — which, until Amphora
 * registers our endpoint, is every international return. That is genuinely
 * unknown, so it reports as such instead of borrowing a Correos phase.
 */
export function amphoraTrackingStatus(
  returnStatus: string | null | undefined
): TrackingStatus {
  if (!returnStatus) return UNKNOWN_TRACKING;
  return AMPHORA_PHASES[returnStatus.trim().toUpperCase()] ?? UNKNOWN_TRACKING;
}

function firstString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * Parse a response from the Correos localizador.
 *
 * Shape (verified live): a one-element array whose object carries
 * `resumen_ultimo`, an `eventos` array and an `error` block. A parcel Correos
 * cannot trace comes back HTTP 200 with `error.codError = "3"`
 * ("Sin Trazabilidad en Minerva") and every data field null — which is why the
 * error block has to be read before anything else.
 */
export function parseCorreosTracking(payload: unknown): TrackingStatus {
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!record || typeof record !== "object") return UNKNOWN_TRACKING;

  const row = record as Record<string, any>;

  // Correos answers 200 even when it holds nothing, so the error block — not
  // the HTTP status and not the emptiness of `resumen_ultimo` — is what tells
  // us the difference between "no data" and "not yet deposited".
  const codError = row.error?.codError;
  if (codError != null && String(codError) !== "0") return UNKNOWN_TRACKING;

  const events = Array.isArray(row.eventos) ? row.eventos : [];
  const lastEvent = events.length ? events[events.length - 1] : null;

  const label = firstString(
    row.resumen_ultimo,
    lastEvent?.desTextoResumen,
    lastEvent?.desFase,
    lastEvent?.desTextoAmpliado
  );

  if (!label) return UNKNOWN_TRACKING;

  return { label, phase: trackingPhase(label) };
}

/** Whether the parcel has entered the carrier network. */
export type CarrierMovement = "moved" | "not-moved" | "unreadable";

/** Phases that mean the customer has handed the parcel over. */
const MOVED_PHASES: ReadonlyArray<TrackingPhase> = [
  "admitido",
  "en_transito",
  "en_reparto",
  "entregado",
  "incidencia",
];

/**
 * Has this parcel moved?
 *
 * Separate from `parseCorreosTracking`, which answers "what should the
 * dashboard show" and is free to collapse everything it cannot read into one
 * display state. This answers "may we cancel", where the difference between
 * "Correos says nothing has happened" and "Correos did not answer" decides
 * whether a refund is safe.
 *
 * `unreadable` covers an unrecognised wording too. A label we cannot map to a
 * phase might mean the parcel is in transit, and guessing in the permissive
 * direction refunds a customer whose garment is already on its way.
 */
export function carrierMovement(payload: unknown): CarrierMovement {
  const record = Array.isArray(payload) ? payload[0] : payload;
  if (!record || typeof record !== "object") return "unreadable";

  const row = record as Record<string, any>;

  const codError = row.error?.codError;
  if (codError != null && String(codError) !== "0") return "unreadable";

  const events = Array.isArray(row.eventos) ? row.eventos : [];
  const lastEvent = events.length ? events[events.length - 1] : null;
  if (!lastEvent) return "not-moved";

  const label =
    lastEvent.desTextoResumen || lastEvent.desFase || lastEvent.desTextoAmpliado;
  if (!label) return "not-moved";

  const phase = trackingPhase(String(label));
  if (MOVED_PHASES.indexOf(phase) !== -1) return "moved";
  if (phase === "prerregistrado") return "not-moved";
  return "unreadable";
}
