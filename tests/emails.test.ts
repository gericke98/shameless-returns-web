import { describe, expect, it } from "vitest";
import {
  buildAmphoraEmail,
  buildCorreosEmail,
  buildSendcloudEmail,
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
const SENDCLOUD_MARKERS = {
  es: ["Hola <strong>", "etiqueta de devolución prepagada", "Saludos,"],
  en: ["Hello <strong>", "pre-paid return label", "Best regards"],
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

describe("buildSendcloudEmail", () => {
  const labelUrl = "https://app.example/api/return-label/42?sig=abc";

  it("emits Spanish only", () => {
    const { HtmlBody } = buildSendcloudEmail("Ana", "es", labelUrl, "TRK9");
    expectSingleLanguage(HtmlBody, "es", SENDCLOUD_MARKERS);
  });

  it("emits English only", () => {
    const { HtmlBody } = buildSendcloudEmail("Ana", "en", labelUrl, "TRK9");
    expectSingleLanguage(HtmlBody, "en", SENDCLOUD_MARKERS);
  });

  it("localizes the subject, the button and the tracking line", () => {
    const es = buildSendcloudEmail("Ana", "es", labelUrl, "TRK9");
    const en = buildSendcloudEmail("Ana", "en", labelUrl, "TRK9");

    expect(es.Subject).toBe("Tu etiqueta de devolución está lista");
    expect(en.Subject).toBe("Your return label is ready");

    expect(es.HtmlBody).toContain("Descarga e imprime tu etiqueta");
    expect(en.HtmlBody).toContain("Download &amp; print your return label");

    expect(es.HtmlBody).toContain("Número de seguimiento");
    expect(en.HtmlBody).toContain("Tracking number");
  });

  it("keeps the label link in both the HTML and the text body", () => {
    for (const locale of ["es", "en"] as const) {
      const email = buildSendcloudEmail("Ana", locale, labelUrl, null);
      expect(email.HtmlBody).toContain(labelUrl);
      expect(email.TextBody).toContain(labelUrl);
    }
  });

  it("omits the tracking line when there is no tracking number", () => {
    const es = buildSendcloudEmail("Ana", "es", labelUrl, null).HtmlBody;
    expect(es).not.toContain("Número de seguimiento");
    const en = buildSendcloudEmail("Ana", "en", labelUrl, null).HtmlBody;
    expect(en).not.toContain("Tracking number");
  });

  it("has no language separator", () => {
    for (const locale of ["es", "en"] as const) {
      expect(
        buildSendcloudEmail("Ana", locale, labelUrl, "TRK9").HtmlBody
      ).not.toContain("<hr");
    }
  });
});
