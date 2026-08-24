// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrackingCapture } from "@/app/[id]/components/trackingCapture";

// No `globals: true` in vitest.config.ts, so @testing-library/react's
// auto-cleanup (which only fires when it finds a global `afterEach`) never
// kicks in. Without this, the second test's screen.getByText sees BOTH
// renders' DOM and throws "multiple elements found".
afterEach(cleanup);

vi.mock("@/actions/selfBookedTracking", () => ({
  submitReturnTracking: async () => ({ ok: true }),
}));

vi.mock("@/lib/i18n/context", () => ({
  useT: () => ({
    tracking: {
      title: "Tell us the tracking number",
      carrier: "Carrier",
      number: "Tracking number",
      submit: "Send",
      permanent: "We cannot change this later, so please check it carefully.",
    },
  }),
  useLocale: () => "en",
}));

describe("TrackingCapture", () => {
  it("lists the carriers the customer can pick", () => {
    render(<TrackingCapture id="132210" />);

    expect(screen.getByText("DHL")).toBeTruthy();
    expect(screen.getByText("Correos")).toBeTruthy();
  });

  it("warns that the tracking number cannot be changed", () => {
    // Amphora pins carrier_number write-once. A typo is permanent, so the
    // customer has to be told before they commit, not after.
    render(<TrackingCapture id="132210" />);

    expect(
      screen.getByText(/cannot change this later/i)
    ).toBeTruthy();
  });
});
