import { describe, expect, it } from "vitest";
import {
  buildSelfReturnInstructionsEmail,
  buildSelfReturnReminderEmail,
} from "@/lib/emails";

const WAREHOUSE = "Calle Pelaya 25";
const PORTAL_URL = "https://returns.shamelesscollective.com";

describe("self-booked return instructions", () => {
  it("gives the customer the warehouse address", () => {
    // Without this they have nowhere to send the parcel, which is the one
    // thing this lane must supply.
    const mail = buildSelfReturnInstructionsEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );

    expect(mail.HtmlBody).toContain(WAREHOUSE);
  });

  it("links back to the portal so they can submit tracking", () => {
    const mail = buildSelfReturnInstructionsEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );

    expect(mail.HtmlBody).toContain(`${PORTAL_URL}/132210`);
  });

  it("warns about customs when shipping from outside the EU", () => {
    // The one support burden this lane invites that the other two do not: the
    // customer arranges their own paperwork, and a parcel held at the border
    // costs them money we cannot refund.
    const mail = buildSelfReturnInstructionsEmail(
      "Ferran",
      "en",
      "132210",
      PORTAL_URL
    );

    expect(mail.HtmlBody.toLowerCase()).toContain("customs");
  });

  it("never claims a label is attached", () => {
    // There is no label. The Correos template says one is attached, and
    // reusing its copy here would be a lie.
    const mail = buildSelfReturnInstructionsEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );

    expect(mail.HtmlBody.toLowerCase()).not.toContain("etiqueta adjunta");
  });

  it.each(["es", "en"] as const)(
    "warns, in %s, that the link will ask them to identify themselves",
    (locale) => {
      // ORDER_SESSION_TTL_MS is 2 hours and `/[id]` redirects to the lookup
      // form without a live session. The two-phase design means the customer
      // comes back AFTER the post office, and the day-3 reminder is by
      // construction ~72h after the session was issued — so this link asks for
      // a login essentially every time. Unannounced, on the very email whose
      // job is to rescue an abandoned return, that reads as a broken link.
      const instructions = buildSelfReturnInstructionsEmail(
        "Ferran",
        locale,
        "132210",
        PORTAL_URL
      );
      const reminder = buildSelfReturnReminderEmail(
        "Ferran",
        locale,
        "132210",
        PORTAL_URL
      );

      const expected =
        locale === "es"
          ? "Te pediremos tu número de pedido y tu email"
          : "We will ask for your order number and email";

      // Both emails carry the same link, so both need the same warning.
      expect(instructions.HtmlBody).toContain(expected);
      expect(reminder.HtmlBody).toContain(expected);
    }
  );

  it("ships in both languages", () => {
    const es = buildSelfReturnInstructionsEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );
    const en = buildSelfReturnInstructionsEmail(
      "Ferran",
      "en",
      "132210",
      PORTAL_URL
    );

    expect(es.Subject).not.toBe(en.Subject);
  });
});

describe("self-booked return reminder", () => {
  it("asks for the tracking number", () => {
    const mail = buildSelfReturnReminderEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );

    expect(mail.Subject.length).toBeGreaterThan(0);
    expect(mail.HtmlBody).toContain("132210");
  });

  it("is a different message from the instructions", () => {
    const first = buildSelfReturnInstructionsEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );
    const nudge = buildSelfReturnReminderEmail(
      "Ferran",
      "es",
      "132210",
      PORTAL_URL
    );

    expect(nudge.Subject).not.toBe(first.Subject);
  });
});
