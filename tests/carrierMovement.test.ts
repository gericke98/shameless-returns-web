import { describe, expect, it } from "vitest";
import { carrierMovement } from "@/lib/trackingStatus";

// Whether the customer's parcel has entered the carrier network.
//
// This is the signal that decides whether cancelling a return is honest, so it
// must distinguish three things the old read collapsed into one:
//   moved       the parcel is with Correos; cancelling would refund someone
//               whose garment is already on its way to us
//   not-moved   Correos answered and holds only a pre-registration
//   unreadable  we learned nothing, and must not guess
//
// `unreadable` fails closed on purpose. Wrongly blocking costs a support
// email; wrongly allowing costs the refund AND the garment.

/** Real payload, captured from PQAZXT9800005390128110S on 2026-08-12. */
const PRERREGISTRADO = [
  {
    codEnvio: "PQAZXT9800005390128110S",
    eventos: [
      {
        fecEvento: "12/08/2026",
        horEvento: "00:38:48",
        codEvento: "A090000V",
        desFase: "PRE-ADMISIÓN",
        desTextoResumen: "Prerregistrado",
        desTextoAmpliado:
          "Envío prerregistrado en los sistemas de Correos pendiente de depósito",
      },
    ],
    error: { codError: "0", desError: "" },
  },
];

const withLastEvent = (resumen: string) => [
  {
    codEnvio: "PQ1ES",
    eventos: [
      { desTextoResumen: "Prerregistrado", desFase: "PRE-ADMISIÓN" },
      { desTextoResumen: resumen, desFase: "X" },
    ],
    error: { codError: "0", desError: "" },
  },
];

describe("carrierMovement", () => {
  it("reports a pre-registered parcel as not moved", () => {
    expect(carrierMovement(PRERREGISTRADO)).toBe("not-moved");
  });

  it("reports an accepted parcel as moved", () => {
    expect(carrierMovement(withLastEvent("Admitido."))).toBe("moved");
  });

  it("reports a parcel in transit as moved", () => {
    expect(carrierMovement(withLastEvent("EN TRÁNSITO"))).toBe("moved");
  });

  it("reports a delivered parcel as moved", () => {
    expect(carrierMovement(withLastEvent("Entregado"))).toBe("moved");
  });

  it("treats a carrier error block as unreadable", () => {
    const payload = [{ codEnvio: "PQ1ES", eventos: [], error: { codError: "1", desError: "no data" } }];
    expect(carrierMovement(payload)).toBe("unreadable");
  });

  it("treats an unrecognised wording as unreadable rather than guessing", () => {
    // trackingPhase maps unknown labels to sin_informacion. We do not know
    // whether that wording means the parcel moved, so we must not decide.
    expect(carrierMovement(withLastEvent("Algo que no reconocemos"))).toBe("unreadable");
  });

  it("treats a clean answer with no events as not moved", () => {
    const payload = [{ codEnvio: "PQ1ES", eventos: [], error: { codError: "0", desError: "" } }];
    expect(carrierMovement(payload)).toBe("not-moved");
  });

  it("treats junk as unreadable", () => {
    expect(carrierMovement(null)).toBe("unreadable");
    expect(carrierMovement("nope")).toBe("unreadable");
    expect(carrierMovement([])).toBe("unreadable");
  });
});
