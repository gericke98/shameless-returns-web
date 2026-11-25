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

// The test keeps the old positional shape for its assertions; the mock maps
// the action's object input onto it.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));
vi.mock("@/actions/tracking", () => ({
  submitTracking: (input: any) =>
    input.trackingUrl === undefined
      ? submitReturnTracking(input.expectedOrderId, input.carrierCode, input.trackingNumber)
      : submitReturnTracking(input.expectedOrderId, input.carrierCode, input.trackingNumber, input.trackingUrl),
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
      link: "Tracking link",
      linkHelp: "Paste the tracking link your carrier gave you.",
      linkInvalid: "That doesn't look like a link.",
      noLink: "No link? Email us.",
      orderNumber: "That is your order number.",
      wrongFormat: "Not this carrier's format. Example:",
      pending: "Saved; we'll check it.",
      notAtCarrier: "The carrier doesn't know this number.",
      tooLong: "Too long.",
    },
  }),
  useLocale: () => "en",
}));

beforeEach(() => {
  submitReturnTracking.mockReset();
  submitReturnTracking.mockResolvedValue({ ok: true, value: { pending: false } });
});

describe("TrackingCapture", () => {
  it("lists the carriers the customer can pick", () => {
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

    expect(screen.getByText("DHL")).toBeTruthy();
    expect(screen.getByText("Correos")).toBeTruthy();
  });

  it("warns that the tracking number cannot be changed", () => {
    // Amphora pins carrier_number write-once. A typo is permanent, so the
    // customer has to be told before they commit, not after.
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

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
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

    await user.type(screen.getByLabelText("Tracking number"), "ABC123");
    await user.click(screen.getByRole("button"));

    expect(submitReturnTracking).not.toHaveBeenCalled();
  });

  it("submits the carrier CODE (not the label) and the trimmed number on the second click", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL");
    await user.type(screen.getByLabelText("Tracking number"), "  ABC123  ");
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect(submitReturnTracking).toHaveBeenCalledTimes(1);
    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "DHL", "ABC123");
  });

  it("disarms when the number is edited after the first click, so it takes another click to go through", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

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
    render(<TrackingCapture id="132210" orderNumber="#313127" />);

    await user.type(screen.getByLabelText("Tracking number"), "ABC123");
    await user.click(screen.getByRole("button")); // arms with CORREOS

    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL"); // disarms
    await user.click(screen.getByRole("button")); // only re-arms

    expect(submitReturnTracking).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button"));
    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "DHL", "ABC123");
  });
});

// #312783 / #312737: "Other" sent Amphora an empty carrier_url. For a carrier
// whose link we cannot build, the link is required (Santi, 2026-11-24).
describe("a carrier whose tracking link the customer gives", () => {
  const LINK = "https://www.cttexpresso.pt/track?ref=7280-13972666";

  it("asks for a link only for 'Other'", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    expect(screen.queryByLabelText("Tracking link")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Carrier"), "OTHER");

    expect(screen.getByLabelText("Tracking link")).toBeTruthy();
  });

  it("cannot be sent without a link, or with something that is not one", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "OTHER");
    await user.type(screen.getByLabelText("Tracking number"), "7280/13972666");

    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    await user.type(screen.getByLabelText("Tracking link"), "my parcel");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toBe("That doesn't look like a link.");
    expect(submitReturnTracking).not.toHaveBeenCalled();
  });

  it("shows the link back on the confirm step, then sends it with the number", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "OTHER");
    await user.type(screen.getByLabelText("Tracking number"), "7280/13972666");
    await user.type(screen.getByLabelText("Tracking link"), LINK);

    await user.click(screen.getByRole("button"));
    expect(screen.getByText(LINK)).toBeTruthy();
    await user.click(screen.getByRole("button"));

    expect(submitReturnTracking).toHaveBeenCalledWith("132210", "OTHER", "7280/13972666", LINK);
  });

  it("says the link was refused when the server refuses it", async () => {
    submitReturnTracking.mockResolvedValue({ ok: false, reason: "invalid-url" });
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "OTHER");
    await user.type(screen.getByLabelText("Tracking number"), "7280/13972666");
    await user.type(screen.getByLabelText("Tracking link"), LINK);
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("alert")).textContent).toBe("That doesn't look like a link.");
  });
});

// #311595 and #313127 sent their own order number as the tracking number,
// and Amphora pinned it write-once.
describe("a number that cannot be the tracking number", () => {
  it.each(["313127", "#313127", " 313 127 "])("refuses the order number (%s) before sending", async (typed) => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.type(screen.getByLabelText("Tracking number"), typed);

    expect(screen.getByRole("alert").textContent).toBe("That is your order number.");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("refuses a NACEX number without its agency, and shows the format", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "NACEX");
    const input = screen.getByLabelText("Tracking number");
    expect(input.getAttribute("placeholder")).toBe("7280/13972666");

    await user.type(input, "13972666");
    expect(screen.getByRole("alert").textContent).toBe("Not this carrier's format. Example: 7280/13972666");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);

    await user.clear(input);
    await user.type(input, "7280/13972666");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
  });

  it("shows the server's order-number refusal", async () => {
    submitReturnTracking.mockResolvedValue({ ok: false, reason: "order-number" });
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#999999" />);
    await user.type(screen.getByLabelText("Tracking number"), "ABC123");
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("alert")).textContent).toBe("That is your order number.");
  });

  // Codex review: the server's 64-character bound was unknown to the form, so
  // a long value was sendable and its refusal read as a format error with an
  // empty example. One shared check now gives each problem its own message.
  it("says a too-long number is too long, before sending", async () => {
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL");
    await user.type(screen.getByLabelText("Tracking number"), "1".repeat(65));

    expect(screen.getByRole("alert").textContent).toBe("Too long.");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
  });

  it("says the number is saved and being checked when the server holds it for ops", async () => {
    submitReturnTracking.mockResolvedValue({ ok: true, value: { pending: true } });
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    await user.selectOptions(screen.getByLabelText("Carrier"), "DHL");
    await user.type(screen.getByLabelText("Tracking number"), "JD0123456789");
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect(await screen.findByText("Saved; we'll check it.")).toBeTruthy();
    expect(screen.queryByText("Thank you! The warehouse now knows your parcel is on its way.")).toBeNull();
  });

  it("shows the carrier's refusal, and lets the customer correct the number", async () => {
    submitReturnTracking.mockResolvedValue({ ok: false, reason: "not-at-carrier" });
    const user = userEvent.setup();
    render(<TrackingCapture id="132210" orderNumber="#313127" />);
    const input = screen.getByLabelText("Tracking number");
    await user.type(input, "PQ0000000000000000000XX");
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect((await screen.findByRole("alert")).textContent).toBe("The carrier doesn't know this number.");
    await user.type(input, "1");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
