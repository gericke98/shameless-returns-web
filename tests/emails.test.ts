import { describe, expect, it } from "vitest";
import {
  buildAmphoraEmail,
  buildCollectionScheduledEmail,
  buildCorreosEmail,
  buildReturnReceivedEmail,
} from "@/lib/emails";

// Marker phrases that must appear in one language and never in the other.
// These are what regress if the two-language stacked template comes back, or if
// the wrong locale is selected.
const CORREOS_MARKERS = {
  es: ["Hola <strong>", "Pasos para completar tu devolución", "Saludos cordiales"],
  en: ["Hello <strong>", "Steps to complete your return", "Best regards"],
};
const AMPHORA_MARKERS = {
  es: ["Hola <strong>", "Nuestro mensajero", "Saludos,"],
  en: ["Hello <strong>", "Our courier will", "Best regards"],
};

function expectSingleLanguage(
  html: string,
  locale: "es" | "en",
  markers: { es: string[]; en: string[] }
) {
  const other = locale === "es" ? "en" : "es";
  for (const marker of markers[locale]) expect(html).toContain(marker);
  for (const marker of markers[other]) expect(html).not.toContain(marker);
}

describe("buildCorreosEmail", () => {
  it("emits Spanish only", () => {
    const { HtmlBody } = buildCorreosEmail("Ana", "es");
    expectSingleLanguage(HtmlBody, "es", CORREOS_MARKERS);
  });

  it("emits English only", () => {
    const { HtmlBody } = buildCorreosEmail("Ana", "en");
    expectSingleLanguage(HtmlBody, "en", CORREOS_MARKERS);
  });

  it("localizes the subject and the text body", () => {
    expect(buildCorreosEmail("Ana", "es").Subject).toBe(
      "Tu devolución se ha creado correctamente"
    );
    expect(buildCorreosEmail("Ana", "en").Subject).toBe(
      "Your return was successfully created"
    );
    expect(buildCorreosEmail("Ana", "es").TextBody).toContain("devolución");
    expect(buildCorreosEmail("Ana", "en").TextBody).toContain("return");
  });

  it("has no language separator and keeps the embedded logo", () => {
    for (const locale of ["es", "en"] as const) {
      const { HtmlBody } = buildCorreosEmail("Ana", locale);
      expect(HtmlBody).not.toContain("<hr");
      expect(HtmlBody).toContain('<img src="cid:embedded-image"');
    }
  });

  it("interpolates the customer name without translating it", () => {
    for (const locale of ["es", "en"] as const) {
      expect(buildCorreosEmail("María Ruiz", locale).HtmlBody).toContain(
        "<strong>María Ruiz</strong>"
      );
    }
  });
});

describe("buildAmphoraEmail", () => {
  const tracking = { number: "TRK123", url: "https://track.example/TRK123" };

  it("emits Spanish only", () => {
    const { HtmlBody } = buildAmphoraEmail("Ana", "es", tracking);
    expectSingleLanguage(HtmlBody, "es", AMPHORA_MARKERS);
  });

  it("emits English only", () => {
    const { HtmlBody } = buildAmphoraEmail("Ana", "en", tracking);
    expectSingleLanguage(HtmlBody, "en", AMPHORA_MARKERS);
  });

  it("localizes the subject", () => {
    expect(buildAmphoraEmail("Ana", "es", tracking).Subject).toBe(
      "Tu devolución se ha creado correctamente"
    );
    expect(buildAmphoraEmail("Ana", "en", tracking).Subject).toBe(
      "Your return was successfully created"
    );
  });

  it("localizes the tracking line, present or pending", () => {
    expect(buildAmphoraEmail("Ana", "es", tracking).HtmlBody).toContain(
      "Puedes seguir la recogida aquí"
    );
    expect(buildAmphoraEmail("Ana", "en", tracking).HtmlBody).toContain(
      "You can track the collection here"
    );

    const pendingEs = buildAmphoraEmail("Ana", "es", {
      number: null,
      url: null,
    }).HtmlBody;
    expect(pendingEs).toContain("datos de seguimiento");
    expect(pendingEs).not.toContain("We will email you");

    const pendingEn = buildAmphoraEmail("Ana", "en", {
      number: null,
      url: null,
    }).HtmlBody;
    expect(pendingEn).toContain("We will email you the tracking details");
  });

  it("has no language separator", () => {
    for (const locale of ["es", "en"] as const) {
      expect(buildAmphoraEmail("Ana", locale, tracking).HtmlBody).not.toContain(
        "<hr"
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Exchanges                                                                   */
/*                                                                             */
/* A CAMBIO and a DEVOLUCIÓN used to produce byte-identical emails: a customer  */
/* who paid to swap a size was told only that a "return" had been created, with */
/* no mention of the replacement they were owed. The delivery method (Correos   */
/* label vs Amphora collection) is orthogonal to this, so BOTH builders take    */
/* the same `exchange` argument.                                               */
/* -------------------------------------------------------------------------- */

const AMALFI = "STAR AMALFI PANTS — Medium (40)";

describe("exchange copy", () => {
  const tracking = { number: "TRK123", url: "https://track.example/TRK123" };
  const exchange = { replacements: [AMALFI] };

  it("retitles the Correos subject as an exchange", () => {
    expect(buildCorreosEmail("Ana", "es", exchange).Subject).toBe(
      "Tu cambio se ha confirmado"
    );
    expect(buildCorreosEmail("Ana", "en", exchange).Subject).toBe(
      "Your exchange is confirmed"
    );
  });

  it("retitles the Amphora subject as an exchange", () => {
    expect(buildAmphoraEmail("Ana", "es", tracking, exchange).Subject).toBe(
      "Tu cambio se ha confirmado"
    );
    expect(buildAmphoraEmail("Ana", "en", tracking, exchange).Subject).toBe(
      "Your exchange is confirmed"
    );
  });

  it("names the replacement item in both builders", () => {
    expect(buildCorreosEmail("Ana", "en", exchange).HtmlBody).toContain(AMALFI);
    expect(buildAmphoraEmail("Ana", "en", tracking, exchange).HtmlBody).toContain(
      AMALFI
    );
  });

  it("promises the replacement ships after the return arrives", () => {
    expect(buildAmphoraEmail("Ana", "en", tracking, exchange).HtmlBody).toContain(
      "Once we receive your return"
    );
    expect(buildAmphoraEmail("Ana", "es", tracking, exchange).HtmlBody).toContain(
      "Cuando recibamos tu devolución"
    );
  });

  it("stays single-language in exchange mode", () => {
    expectSingleLanguage(
      buildCorreosEmail("Ana", "es", exchange).HtmlBody,
      "es",
      CORREOS_MARKERS
    );
    expectSingleLanguage(
      buildAmphoraEmail("Ana", "en", tracking, exchange).HtmlBody,
      "en",
      AMPHORA_MARKERS
    );
  });

  it("still marks it an exchange when the replacement cannot be named", () => {
    const unnamed = { replacements: [] };
    const html = buildAmphoraEmail("Ana", "en", tracking, unnamed).HtmlBody;
    expect(buildAmphoraEmail("Ana", "en", tracking, unnamed).Subject).toBe(
      "Your exchange is confirmed"
    );
    // No dangling "replacement:" with nothing after it.
    expect(html).not.toContain("replacement:");
  });

  it("leaves plain returns untouched", () => {
    expect(buildCorreosEmail("Ana", "en").Subject).toBe(
      "Your return was successfully created"
    );
    expect(buildAmphoraEmail("Ana", "en", tracking).Subject).toBe(
      "Your return was successfully created"
    );
    expect(buildCorreosEmail("Ana", "en").HtmlBody).not.toContain("exchange");
    expect(buildAmphoraEmail("Ana", "en", tracking).HtmlBody).not.toContain(
      "Once we receive your return"
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle notifications (driven by the Amphora status webhooks)             */
/* -------------------------------------------------------------------------- */

describe("buildCollectionScheduledEmail", () => {
  const tracking = { number: "1Z999", url: "https://ups.com/1Z999" };

  it("localizes the subject", () => {
    expect(buildCollectionScheduledEmail("Ana", "es", tracking).Subject).toBe(
      "Tu recogida está programada"
    );
    expect(buildCollectionScheduledEmail("Ana", "en", tracking).Subject).toBe(
      "Your collection is scheduled"
    );
  });

  it("shows the carrier tracking link", () => {
    const { HtmlBody } = buildCollectionScheduledEmail("Ana", "en", tracking);
    expect(HtmlBody).toContain("1Z999");
    expect(HtmlBody).toContain("https://ups.com/1Z999");
  });

  it("still shows the number when the carrier gave no URL", () => {
    const { HtmlBody } = buildCollectionScheduledEmail("Ana", "en", {
      number: "1Z999",
      url: null,
    });
    expect(HtmlBody).toContain("1Z999");
  });

  it("names the replacement for an exchange", () => {
    const { HtmlBody } = buildCollectionScheduledEmail("Ana", "en", tracking, {
      replacements: ["STAR AMALFI PANTS — Medium (40)"],
    });
    expect(HtmlBody).toContain("STAR AMALFI PANTS — Medium (40)");
  });

  it("stays single-language", () => {
    expect(
      buildCollectionScheduledEmail("Ana", "es", tracking).HtmlBody
    ).not.toContain("Your collection");
    expect(
      buildCollectionScheduledEmail("Ana", "en", tracking).HtmlBody
    ).not.toContain("Tu recogida");
  });
});

describe("buildReturnReceivedEmail", () => {
  it("localizes the subject", () => {
    expect(buildReturnReceivedEmail("Ana", "es").Subject).toBe(
      "Hemos recibido tu devolución"
    );
    expect(buildReturnReceivedEmail("Ana", "en").Subject).toBe(
      "We've received your return"
    );
  });

  it("promises a refund on a plain return", () => {
    expect(buildReturnReceivedEmail("Ana", "en").HtmlBody).toContain(
      "process your refund"
    );
  });

  it("tells an exchange customer their replacement is next, not a refund", () => {
    const { HtmlBody } = buildReturnReceivedEmail("Ana", "en", {
      replacements: ["STAR AMALFI PANTS — Medium (40)"],
    });
    expect(HtmlBody).toContain("STAR AMALFI PANTS — Medium (40)");
    expect(HtmlBody).not.toContain("process your refund");
  });

  it("stays single-language", () => {
    expect(buildReturnReceivedEmail("Ana", "en").HtmlBody).not.toContain(
      "Hemos recibido"
    );
    expect(buildReturnReceivedEmail("Ana", "es").HtmlBody).not.toContain(
      "We've received"
    );
  });
});
