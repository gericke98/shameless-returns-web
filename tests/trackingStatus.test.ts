import { describe, expect, it } from "vitest";
import {
  amphoraTrackingStatus,
  parseCorreosTracking,
  trackingPhase,
  tracksWithCorreos,
} from "@/lib/trackingStatus";

// `obtainLastStatus` collapsed three different realities into one confident
// claim:
//
//   if (!response.data[0].resumen_ultimo) return "Prerregistrado";
//
// "Prerregistrado" means "Correos has the label but the parcel has not been
// deposited". Returning it for a parcel Correos knows NOTHING about states the
// opposite of the truth for a parcel that was delivered months ago.
//
// Measured against all 415 live locators on 2026-07-30:
//   260  Entregado
//    82  codError 3, "Sin Trazabilidad en Minerva"  -> shown as Prerregistrado
//    59  genuinely Prerregistrado
//    11  event present, resumen_ultimo null         -> shown as Prerregistrado
//     3  Clasificado / "Admitido." / "A disposición del destinatario"
//
// All 82 error-3 locators carry the PQAZXT0710 prefix and belong to orders
// #35739-#36398 — parcels long since delivered and aged out of Correos's
// traceability system.
//
// The payload shapes below are copied verbatim from those live responses.

const delivered = [
  {
    codEnvio: "PQAZXT9800004250128221N",
    eventos: [
      {
        fecEvento: "21/07/2026",
        codEvento: "I010000V",
        desFase: "ENTREGADO",
        desTextoResumen: "Entregado",
        desTextoAmpliado: "Envío entregado al destinatario o autorizado",
      },
    ],
    error: { codError: "0", desError: "" },
    resumen_ultimo: "Entregado",
  },
];

const noTraceability = [
  {
    codEnvio: "PQAZXT0710002040128224R",
    eventos: null,
    error: { codError: "3", desError: "Sin Trazabilidad en Minerva." },
    resumen_ultimo: null,
  },
];

const eventWithoutSummary = [
  {
    codEnvio: "PQAZXT9800004370128221S",
    eventos: [
      {
        fecEvento: "20/07/2026",
        codEvento: "",
        desFase: null,
        desTextoResumen: null,
        desTextoAmpliado: "",
      },
    ],
    error: { codError: "0", desError: "" },
    resumen_ultimo: null,
  },
];

const preRegistered = [
  {
    codEnvio: "PQAZXT9800004900128221Z",
    eventos: [
      {
        desFase: "PRE-ADMISIÓN",
        desTextoResumen: "Prerregistrado",
        desTextoAmpliado:
          "Envío prerregistrado en los sistemas de Correos pendiente de depósito",
      },
    ],
    error: { codError: "0", desError: "" },
    resumen_ultimo: "Prerregistrado",
  },
];

describe("parseCorreosTracking", () => {
  it("reports the delivered status Correos actually returned", () => {
    const result = parseCorreosTracking(delivered);
    expect(result.label).toBe("Entregado");
    expect(result.phase).toBe("entregado");
  });

  it("does NOT claim Prerregistrado when Correos has no traceability", () => {
    // The whole point. 82 live locators hit this branch.
    const result = parseCorreosTracking(noTraceability);
    expect(result.phase).toBe("sin_informacion");
    expect(result.label).not.toBe("Prerregistrado");
  });

  it("does NOT claim Prerregistrado when an event exists but carries no summary", () => {
    const result = parseCorreosTracking(eventWithoutSummary);
    expect(result.phase).not.toBe("prerregistrado");
    expect(result.label).not.toBe("Prerregistrado");
  });

  it("still reports Prerregistrado when that is genuinely the last event", () => {
    const result = parseCorreosTracking(preRegistered);
    expect(result.label).toBe("Prerregistrado");
    expect(result.phase).toBe("prerregistrado");
  });

  it("falls back to the event phase when the summary is missing", () => {
    const result = parseCorreosTracking([
      {
        eventos: [{ desFase: "EN CAMINO", desTextoResumen: null, desTextoAmpliado: "" }],
        error: { codError: "0", desError: "" },
        resumen_ultimo: null,
      },
    ]);
    expect(result.label).toBe("EN CAMINO");
    expect(result.phase).toBe("en_transito");
  });

  it("treats an empty or malformed payload as unknown, never as pre-registered", () => {
    for (const payload of [[], null, undefined, {}, "nonsense"]) {
      const result = parseCorreosTracking(payload);
      expect(result.phase).toBe("sin_informacion");
      expect(result.label).not.toBe("Prerregistrado");
    }
  });
});

describe("trackingPhase", () => {
  it("normalises the punctuation Correos actually sends", () => {
    // Live data contains "Admitido." WITH a trailing period. The dashboard
    // filter compared the raw string against the option value "admitido" and
    // so matched nothing at all.
    expect(trackingPhase("Admitido.")).toBe("admitido");
    expect(trackingPhase("Entregado")).toBe("entregado");
  });

  it("normalises accents and case", () => {
    expect(trackingPhase("EN TRÁNSITO")).toBe("en_transito");
    expect(trackingPhase("en transito")).toBe("en_transito");
  });

  it("maps the delivery-in-progress wordings Correos uses", () => {
    expect(trackingPhase("En reparto")).toBe("en_reparto");
    expect(trackingPhase("A disposición del destinatario")).toBe("en_reparto");
  });

  it("maps in-transit wordings", () => {
    expect(trackingPhase("Clasificado")).toBe("en_transito");
    expect(trackingPhase("EN CAMINO")).toBe("en_transito");
  });

  it("returns sin_informacion for anything it does not recognise", () => {
    expect(trackingPhase("")).toBe("sin_informacion");
    expect(trackingPhase(null)).toBe("sin_informacion");
    expect(trackingPhase("Algo totalmente nuevo")).toBe("sin_informacion");
  });
});

describe("tracksWithCorreos", () => {
  it("treats an order with no carrier as domestic Correos", () => {
    // Domestic returns write only `locator`; `carrier` stays null.
    expect(tracksWithCorreos(null)).toBe(true);
    expect(tracksWithCorreos(undefined)).toBe(true);
  });

  it("recognises Correos even when Amphora is the one who booked it", () => {
    // Order #310843 (Portugal) has carrier "correos" and a valid Correos code.
    expect(tracksWithCorreos("correos")).toBe(true);
    expect(tracksWithCorreos("CORREOS EXPRESS")).toBe(true);
  });

  it("excludes carriers Correos has never heard of", () => {
    // Asking Correos about these returns "no traceability", which the old code
    // rendered as "Prerregistrado" — the original bug in a new place.
    expect(tracksWithCorreos("dhl")).toBe(false);
    expect(tracksWithCorreos("UPS")).toBe(false);
    expect(tracksWithCorreos("seur")).toBe(false);
  });
});

describe("amphoraTrackingStatus", () => {
  it("maps the lifecycle onto the shared phases", () => {
    expect(amphoraTrackingStatus("TRAVELLING").phase).toBe("en_transito");
    expect(amphoraTrackingStatus("RECEIVED").phase).toBe("entregado");
    expect(amphoraTrackingStatus("FINISHED").phase).toBe("entregado");
  });

  it("accepts APROVED, Amphora's one-P wire spelling", () => {
    const status = amphoraTrackingStatus("APROVED");
    expect(status.phase).toBe("admitido");
    expect(status.label).toBe("Recogida programada");
  });

  it("surfaces exceptions as their own phase rather than hiding them", () => {
    expect(amphoraTrackingStatus("EXCEPTION").phase).toBe("incidencia");
    expect(amphoraTrackingStatus("EXCEPTION_WAREHOUSE").phase).toBe("incidencia");
    expect(amphoraTrackingStatus("FINISHED_REJECTED").phase).toBe("incidencia");
  });

  it("reports unknown when no webhook has arrived yet", () => {
    // True for every international return until Amphora registers our endpoint.
    expect(amphoraTrackingStatus(null).phase).toBe("sin_informacion");
    expect(amphoraTrackingStatus("").phase).toBe("sin_informacion");
  });

  it("does not guess at a status it has never seen", () => {
    expect(amphoraTrackingStatus("SOMETHING_NEW").phase).toBe("sin_informacion");
  });
});
