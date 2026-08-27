import { describe, expect, it } from "vitest";
import { buildTrackingUpdateEmail } from "@/lib/emails";
import type { TrackingKey } from "@/lib/trackingUpdate";

const KEYS: TrackingKey[] = ["accepted", "in_transit", "received", "problem"];

describe("buildTrackingUpdateEmail", () => {
  it("builds a distinct message for every key, in both locales", () => {
    const subjects = new Set<string>();
    for (const key of KEYS) {
      for (const locale of ["es", "en"] as const) {
        const mail = buildTrackingUpdateEmail(key, "Aida", locale);
        expect(mail.Subject, `${key}/${locale}`).toBeTruthy();
        expect(mail.TextBody, `${key}/${locale}`).toBeTruthy();
        expect(mail.HtmlBody, `${key}/${locale}`).toContain("Aida");
        subjects.add(`${locale}:${mail.Subject}`);
      }
    }
    // Eight distinct subjects — no key silently reusing another's copy.
    expect(subjects.size).toBe(8);
  });

  it("addresses the customer by name", () => {
    const mail = buildTrackingUpdateEmail("received", "Mackenzie", "en");
    expect(mail.HtmlBody).toContain("Mackenzie");
  });

  it("leaves the recipient for the sender to fill in", () => {
    // Every builder in this file returns To: "" and the caller sets it.
    expect(buildTrackingUpdateEmail("accepted", "Aida", "es").To).toBe("");
  });

  it("does not promise a refund timeline on the received notice", () => {
    // Settlement is a separate job with its own grace period. Promising "within
    // N days" here would be a commitment this email cannot keep.
    for (const locale of ["es", "en"] as const) {
      const body = buildTrackingUpdateEmail("received", "Aida", locale).HtmlBody;
      expect(body).not.toMatch(/\d+\s*(d[íi]as|days|horas|hours)/i);
    }
  });

  it("tells a customer with a problem to contact us", () => {
    for (const locale of ["es", "en"] as const) {
      const body = buildTrackingUpdateEmail("problem", "Aida", locale).HtmlBody;
      expect(body).toContain("@");
    }
  });
});
