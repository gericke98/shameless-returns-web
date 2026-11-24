import { describe, expect, it } from "vitest";
import { CARRIERS, carrierByCode, isOrderReference, nacexParts } from "@/lib/carriers";

// Each built link was opened in a browser on 2026-11-24 and lands on the
// number's tracking. These pin the exact shapes that were checked.
const CHECKED: Record<string, [string, string]> = {
  CORREOS: ["PQ0B7K0000043680128110B", "https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=PQ0B7K0000043680128110B"],
  DHL: ["CY444710999DE", "https://www.dhl.com/global-en/home/tracking.html?tracking-id=CY444710999DE&submit=1"],
  CTT: ["DB336280257PT", "https://appserver2.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=DB336280257PT"],
  NACEX: ["7280/13972666", "https://www.nacex.es/seguimientoDetalle.do?agencia_origen=7280&numero_albaran=13972666&externo=N"],
  ROYALMAIL: ["LE403951332GB", "https://www.royalmail.com/track-your-item#/tracking-results/LE403951332GB"],
  BPOST: ["CE643871536BE", "https://track.bpost.cloud/btr/web/#/search?itemCode=CE643871536BE&lang=en"],
  GLS: ["12345678901", "https://gls-group.com/ES/es/seguimiento-envio?match=12345678901"],
  ANPOST: ["CE123456789IE", "https://www.anpost.com/Post-Parcels/Track/History?item=CE123456789IE"],
  UPS: ["1Z999AA10123456784", "https://www.ups.com/track?tracknum=1Z999AA10123456784"],
  FEDEX: ["123456789012", "https://www.fedex.com/fedextrack/?trknbr=123456789012"],
};

describe("carrier tracking links", () => {
  it.each(Object.entries(CHECKED))("%s builds the link that was checked", (code, [n, url]) => {
    const c = carrierByCode(code)!;
    expect(c.link.kind).toBe("built");
    if (c.link.kind === "built") expect(c.link.build(n)).toBe(url);
  });

  it("every carrier has a link source, and the customer gives it only where we cannot build one", () => {
    const customer = CARRIERS.filter((c) => c.link.kind === "customer").map((c) => c.code);
    expect(customer.sort()).toEqual(["MRW", "OTHER"]);
  });

  it("codes are unique and none would be read as Correos's own label", () => {
    const codes = CARRIERS.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("nacexParts", () => {
  it.each([["7280/13972666"], ["7280 / 13972666"], ["7280-13972666"]])("splits %s", (n) => {
    expect(nacexParts(n)).toEqual({ agency: "7280", note: "13972666" });
  });
  it.each([["13972666"], ["728013972666"], ["72/13972666"], ["ABCD/13972666"]])("refuses %s", (n) => {
    expect(nacexParts(n)).toBeNull();
  });
});

describe("isOrderReference", () => {
  const order = { orderNumber: "#313127", id: "13579117199686" };
  it.each(["313127", "#313127", " 313-127 ", "13579117199686"])("is the order's own reference: %s", (n) => {
    expect(isOrderReference(n, order)).toBe(true);
  });
  it.each(["CD0CPS0001314360028110S", "3131270", "7280/13972666", ""])("is not: %s", (n) => {
    expect(isOrderReference(n, order)).toBe(false);
  });
});
