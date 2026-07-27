import { describe, expect, it } from "vitest";
import { ACTIONS, REASON_KEYS } from "@/placeholder";
import { dictionaries } from "@/lib/i18n";
import { isReasonKey, reasonLabel, toReasonKey } from "@/lib/reasons";

describe("ACTIONS", () => {
  it("are the codes already persisted in productsOrder.action", () => {
    // Pinned to the literal strings, not to a constant: these values are read
    // back out of a database that already contains them, and updateOrder.ts,
    // ReturnsTable.tsx, summary.tsx, refund.ts and lib/basket.ts all compare
    // rows against "CAMBIO"/"DEVOLUCIÓN" directly. If someone "translates"
    // these into labels again, every exchange becomes a return.
    expect(ACTIONS.CHANGE).toBe("CAMBIO");
    expect(ACTIONS.RETURN).toBe("DEVOLUCIÓN");
  });

  it("uses the precomposed U+00D3 accent, matching the stored rows", () => {
    // "DEVOLUCIÓN" written with a combining acute (U+004F U+0301) looks
    // identical in an editor but is a different string, so === against a DB
    // row would silently fail.
    expect(ACTIONS.RETURN.normalize("NFC")).toBe(ACTIONS.RETURN);
    expect(ACTIONS.RETURN.split("").map((c) => c.charCodeAt(0))).toEqual([
      0x44, 0x45, 0x56, 0x4f, 0x4c, 0x55, 0x43, 0x49, 0xd3, 0x4e,
    ]);
  });

  it("are not display text", () => {
    // The old values were the dropdown's visible Spanish sentences.
    expect(Object.values(ACTIONS)).not.toContain(
      "Quiero cambiar este producto"
    );
    expect(Object.values(ACTIONS)).not.toContain(
      "Quiero devolver este producto"
    );
  });
});

describe("REASON_KEYS", () => {
  it("has a label in every dictionary", () => {
    for (const locale of ["es", "en"] as const) {
      for (const key of REASON_KEYS) {
        const label = dictionaries[locale].reasons[key];
        expect(label, `${locale}.reasons.${key}`).toBeTruthy();
      }
    }
  });

  it("covers every reason the dictionaries define, with no extras", () => {
    expect([...REASON_KEYS].sort()).toEqual(
      Object.keys(dictionaries.es.reasons).sort()
    );
    expect(Object.keys(dictionaries.en.reasons).sort()).toEqual(
      Object.keys(dictionaries.es.reasons).sort()
    );
  });

  it("contains the default the dialog falls back to", () => {
    expect(REASON_KEYS).toContain("TOO_SMALL");
  });

  it("are codes, not sentences", () => {
    for (const key of REASON_KEYS) {
      expect(key).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("toReasonKey", () => {
  it("passes stable keys through", () => {
    expect(toReasonKey("TOO_SMALL")).toBe("TOO_SMALL");
    expect(toReasonKey("NOT_AS_SHOWN")).toBe("NOT_AS_SHOWN");
  });

  it("maps every legacy Spanish sentence back to its key", () => {
    // The exact ten strings the pre-split dropdown wrote to the column
    // (`REASONS` in placeholder.ts as of 072f4dc^). Pinned here in full so a
    // reword of lib/i18n/es.ts cannot quietly break decoding of live rows:
    // the map in lib/reasons.ts is a frozen literal, not derived from the
    // display dictionary, and this is the test that says so.
    const legacy: Record<string, string> = {
      "Me queda grande": "TOO_BIG",
      "Me queda pequeño": "TOO_SMALL",
      "Es incómodo o me hace daño": "UNCOMFORTABLE",
      "No me gusta": "DISLIKE",
      "Compré varias opciones para probar": "BOUGHT_OPTIONS",
      "El producto está dañado": "DAMAGED",
      "Recibí el producto equivocado": "WRONG_ITEM",
      "El producto llegó demasiado tarde": "LATE",
      "Otro motivo": "OTHER",
      "El producto no es como se mostraba": "NOT_AS_SHOWN",
    };
    expect(Object.keys(legacy)).toHaveLength(REASON_KEYS.length);
    for (const [sentence, key] of Object.entries(legacy)) {
      expect(toReasonKey(sentence), sentence).toBe(key);
    }
  });

  it("keeps decoding legacy rows after the Spanish display copy changes", () => {
    // The failure this guards: LEGACY_ES_LABEL_TO_KEY used to be built from
    // dictionaries.es.reasons, so any reword of that sentence orphaned every
    // legacy row holding it. Reword it here and prove decoding is unaffected.
    const reasons = dictionaries.es.reasons as unknown as Record<
      string,
      string
    >;
    const original = reasons.DAMAGED;
    try {
      reasons.DAMAGED = "El artículo ha llegado roto";
      expect(toReasonKey("El producto está dañado")).toBe("DAMAGED");
      // ...and the new wording is not retroactively a stored value.
      expect(toReasonKey("El artículo ha llegado roto")).toBe("OTHER");
    } finally {
      reasons.DAMAGED = original;
    }
    expect(dictionaries.es.reasons.DAMAGED).toBe("El producto está dañado");
  });

  it("defaults to TOO_SMALL only when nothing was stored", () => {
    expect(toReasonKey(null)).toBe("TOO_SMALL");
    expect(toReasonKey(undefined)).toBe("TOO_SMALL");
    expect(toReasonKey("")).toBe("TOO_SMALL");
  });

  it("maps an unrecognised stored value to OTHER, not TOO_SMALL", () => {
    // The customer did state a reason; we just cannot decode it. Answering
    // TOO_SMALL asserts a claim they never made, and updateOrder persists it.
    expect(toReasonKey("something a human typed")).toBe("OTHER");
    expect(toReasonKey("Too small")).toBe("OTHER"); // English label, never a stored value
    expect(toReasonKey("Me queda pequeñito")).toBe("OTHER"); // near-miss of a legacy sentence
  });
});

describe("reasonLabel", () => {
  it("localizes known keys", () => {
    expect(reasonLabel("TOO_SMALL", dictionaries.es)).toBe("Me queda pequeño");
    expect(reasonLabel("TOO_SMALL", dictionaries.en)).toBe("Too small");
  });

  it("localizes legacy Spanish rows", () => {
    expect(reasonLabel("Me queda pequeño", dictionaries.en)).toBe("Too small");
  });

  it("renders an unrecognised stored value as-is instead of blank", () => {
    expect(reasonLabel("totally unknown", dictionaries.en)).toBe(
      "totally unknown"
    );
  });
});

describe("isReasonKey", () => {
  it("rejects non-keys", () => {
    expect(isReasonKey("TOO_SMALL")).toBe(true);
    expect(isReasonKey("Me queda pequeño")).toBe(false);
    expect(isReasonKey("")).toBe(false);
  });
});
