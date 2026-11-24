import { describe, expect, it } from "vitest";
import { buildSelfTrackingRejectedEmail } from "@/lib/emails";

describe("buildSelfTrackingRejectedEmail", () => {
  it.each(["es", "en"] as const)("quotes the rejected number and links back to the portal (%s)", (locale) => {
    const email = buildSelfTrackingRejectedEmail("Ana", locale, "13221047697734", "https://portal.test", "#311595");
    expect(email.HtmlBody).toContain("#311595");
    expect(email.HtmlBody).toContain("https://portal.test");
    expect(email.TextBody).toContain("#311595");
    expect(email.TextBody).not.toMatch(/<[^>]+>/);
  });

  it("escapes the number, which the customer typed", () => {
    const email = buildSelfTrackingRejectedEmail("Ana", "es", "1", "https://portal.test", "<img src=x>");
    expect(email.HtmlBody).not.toContain("<img src=x>");
  });
});
