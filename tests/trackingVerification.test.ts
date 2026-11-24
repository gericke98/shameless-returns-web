import { describe, expect, it } from "vitest";
import { bpostVerdict, correosVerdict, nacexVerdict } from "@/lib/trackingVerification";

// Real carrier answers captured 2026-11-24, trimmed to the fields read. No
// customer data: the Correos and bpost records carry none in these fields,
// and the NACEX fragments are the status table and the not-found message.

const correosDelivered = [
  {
    codEnvio: "CD0CPS0001314360028110S",
    numReferencia1: null,
    eventos: [{ fecEvento: "24/11/2026", horEvento: "11:15:11", codEvento: "I010000V", desTextoResumen: "Entregado" }],
    // Verbatim: a SUCCESSFUL answer carries an error object with code "0".
    // A fixture with `error: null` passed while the live lookup failed.
    error: { codError: "0", desError: "" },
  },
];
// Asked for "313127" (an order number), the localizador answers with ANOTHER
// parcel that carries 313127 as a reference.
const correosReferenceMatch = [
  {
    codEnvio: "6330003413121560",
    numReferencia1: "313127",
    eventos: [{ fecEvento: "27/09/2026", horEvento: "23:50:42", codEvento: "X010000V", desTextoResumen: "Informado" }],
    error: { codError: "0", desError: "" },
  },
];
const correosUnknown = [
  {
    codEnvio: "PQ0000000000000000000XX",
    eventos: null,
    error: { codError: "3", desError: "Sin Trazabilidad en Minerva." },
  },
];

const NACEX_FOUND =
  '<table id="tabla_estado">\r\n      <tr>\r\n        <td style="text-align:right">Env\xedo:</td>\r\n        <td style="text-align:left; font-size: 18px;">\r\n\t        <b>7280/13972666</b>\r\n        </td>\r\n      </tr>\r\n      <tr>\r\n        <td style="text-align:right">Estado:</td>\r\n        <td style="text-align:left">\r\n                <font style="font-size: 24px;" class="fuente_titulo_green">Entregado</font>            \r\n        </td>\r\n      </tr>\r\n    </table>';
const NACEX_NOT_FOUND =
  '<div class="t9">No existe ning\xfan albar\xe1n introducido en el sistema cumpliendo los criterios especificados.<br>Consulte con su agencia NACEX m\xe1s cercana.</div>';

describe("correosVerdict", () => {
  it("verifies a parcel Correos holds under this exact number", () => {
    expect(correosVerdict(correosDelivered, "CD0CPS0001314360028110S")).toBe("verified");
  });
  it("does NOT verify an order number that matches another parcel's reference (#313127)", () => {
    expect(correosVerdict(correosReferenceMatch, "313127")).toBe("unknown");
  });
  it("says unknown when Correos has no traceability for the number", () => {
    expect(correosVerdict(correosUnknown, "PQ0000000000000000000XX")).toBe("unknown");
  });
  it.each([
    ["an empty answer", []],
    ["not an array", { codEnvio: "X" }],
    ["another error", [{ codEnvio: "X", error: { codError: "9" } }]],
    ["no events", [{ codEnvio: "X", eventos: [] }]],
  ])("is unreadable for %s, never verified or unknown", (_l, payload) => {
    expect(correosVerdict(payload, "X")).toBe("unreadable");
  });
});

describe("nacexVerdict", () => {
  const parts = { agency: "7280", note: "13972666" };
  it("verifies a page that shows this agency/note with a status", () => {
    expect(nacexVerdict(NACEX_FOUND, parts)).toBe("verified");
  });
  it("says unknown when NACEX has no such delivery note", () => {
    expect(nacexVerdict(NACEX_NOT_FOUND, { agency: "7280", note: "99999999" })).toBe("unknown");
  });
  it("is unreadable when the page shows a different number", () => {
    expect(nacexVerdict(NACEX_FOUND, { agency: "7280", note: "13971190" })).toBe("unreadable");
  });
  it("is unreadable for a page it does not recognise", () => {
    expect(nacexVerdict("<html><body>Mantenimiento</body></html>", parts)).toBe("unreadable");
  });
});

describe("bpostVerdict", () => {
  it("verifies an item with this code", () => {
    expect(bpostVerdict({ items: [{ itemCode: "CE643871536BE", searchCode: "CE643871536BE" }] }, "CE643871536BE")).toBe("verified");
  });
  it("says unknown for NO_DATA_FOUND", () => {
    expect(bpostVerdict({ error: "NO_DATA_FOUND" }, "CE000000000BE")).toBe("unknown");
  });
  it.each([
    ["another error", { error: "RATE_LIMITED" }],
    ["items for another code", { items: [{ itemCode: "CE111111111BE" }] }],
    ["null", null],
  ])("is unreadable for %s", (_l, payload) => {
    expect(bpostVerdict(payload, "CE643871536BE")).toBe("unreadable");
  });
});
