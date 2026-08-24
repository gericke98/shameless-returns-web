// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrackingCapture } from "@/app/[id]/components/trackingCapture";

// No `globals: true` in vitest.config.ts, so @testing-library/react's
// auto-cleanup (which only fires when it finds a global `afterEach`) never
// kicks in. Without this, the second test's screen.getByText sees BOTH
// renders' DOM and throws "multiple elements found".
afterEach(cleanup);

const submitReturnTracking = vi.fn();

vi.mock("@/actions/selfBookedTracking", () => ({
  submitReturnTracking: (...args: unknown[]) => submitReturnTracking(...args),
}));

vi.mock("@/lib/i18n/context", () => ({
  useT: () => ({
    tracking: {
      title: "Tell us the tracking number",
      intro: "Once you have sent the parcel, tell us who you sent it with.",
      carrier: "Carrier",
      number: "Tracking number",
      submit: "Send",
      permanent: "We cannot change this later, so please check it carefully.",
      done: "Thank you! The warehouse now knows your parcel is on its way.",
      error: "We could not save that. Check the details and try again.",
    },
  }),
  useLocale: () => "en",
}));

beforeEach(() => {
  submitReturnTracking.mockReset();
  submitReturnTracking.mockResolvedValue({ ok: true });
});

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

// The confirm step is the whole point of this component: Amphora pins
// carrier_number write-once, so a value that slips through on one click can
// never be corrected. These tests drive real clicks/typing rather than
// asserting static markup, because that is the only way to catch a guard
// that silently stops guarding.
describe("the confirm step", () => {
  it("does not submit on a single click", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" />);

    await user.type(screen.getByLabelText("Tracking number"), "ABC123");
    await user.click(screen.getByRole("button"));

    expect(submitReturnTracking).not.toHaveBeenCalled();
  });

  it("submits the carrier CODE (not the label) and the trimmed number on the second click", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" />);

    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL");
    await user.type(screen.getByLabelText("Tracking number"), "  ABC123  ");
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect(submitReturnTracking).toHaveBeenCalledTimes(1);
    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "DHL", "ABC123");
  });

  it("disarms when the number is edited after the first click, so it takes another click to go through", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" />);

    const numberInput = screen.getByLabelText("Tracking number");
    await user.type(numberInput, "ABC123");
    await user.click(screen.getByRole("button")); // arms on "ABC123"

    await user.type(numberInput, "456"); // now "ABC123456" — disarms
    await user.click(screen.getByRole("button")); // this click only re-arms

    expect(submitReturnTracking).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button")); // second click on the value now shown
    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "CORREOS", "ABC123456");
  });

  it("disarms when the carrier is changed after the first click", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" />);

    await user.type(screen.getByLabelText("Tracking number"), "ABC123");
    await user.click(screen.getByRole("button")); // arms with CORREOS

    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL"); // disarms
    await user.click(screen.getByRole("button")); // only re-arms

    expect(submitReturnTracking).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button"));
    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "DHL", "ABC123");
  });
});
