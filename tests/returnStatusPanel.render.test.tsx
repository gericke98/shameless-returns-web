// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// What the customer actually sees and clicks.
//
// This file exists because its absence cost us twice. The panel shipped with
// `setDone(true)` followed by a synchronous `window.location.reload()`: React 18
// batches the state update, so the document unloaded before the confirmation
// could paint and a customer who successfully cancelled saw NOTHING. It also
// shipped rendered above the site header, outside the page shell. Both were
// found by reading, not by testing, because nothing here rendered the component.
//
// So these tests drive the real component through real clicks. Only the server
// action is mocked — it moves money, and it is covered on its own in
// tests/cancelReturn.test.ts.

const cancelReturnFunction = vi.fn();

vi.mock("@/actions/cancelReturn", () => ({
  cancelReturnFunction: (orderId: string) => cancelReturnFunction(orderId),
}));

import { ReturnStatusPanel } from "@/app/[id]/components/returnStatusPanel";
import { LocaleProvider } from "@/lib/i18n/context";
import { es } from "@/lib/i18n/es";
import { en } from "@/lib/i18n/en";
import type { CancelDecision } from "@/lib/cancelEligibility";

const ORDER_ID = "13217168851270";
const LOCATOR = "PQAZXT9800005420128110D";

function renderPanel(
  decision: CancelDecision,
  locale: "es" | "en" = "es",
  locator: string | null = LOCATOR
) {
  return render(
    <LocaleProvider locale={locale}>
      <ReturnStatusPanel
        decision={decision}
        orderId={ORDER_ID}
        locator={locator}
        carrier={null}
      />
    </LocaleProvider>
  );
}

const CANCELLABLE: CancelDecision = { cancellable: true };

/** Click through to the point of no return: Cancel, then confirm. */
async function cancelAndConfirm() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: es.cancel.button }));
  await user.click(screen.getByRole("button", { name: es.cancel.confirmYes }));
  return user;
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cancelReturnFunction.mockReset();
  cancelReturnFunction.mockResolvedValue({ ok: true });

  // jsdom's location.reload is not writable; replace the whole object's method.
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  cleanup();
});

describe("the return panel", () => {
  it("shows the tracking number the customer needs", () => {
    renderPanel(CANCELLABLE);

    expect(screen.getByText(new RegExp(LOCATOR))).toBeTruthy();
  });

  it("offers a cancel button when the return is still cancellable", () => {
    renderPanel(CANCELLABLE);

    expect(screen.getByRole("button", { name: es.cancel.button })).toBeTruthy();
  });

  it("asks for confirmation before doing anything", async () => {
    const user = userEvent.setup();
    renderPanel(CANCELLABLE);

    await user.click(screen.getByRole("button", { name: es.cancel.button }));

    expect(screen.getByText(es.cancel.confirmQuestion)).toBeTruthy();
    // The warning that the label dies is the whole reason for this step.
    expect(screen.getByText(es.cancel.confirmDetail)).toBeTruthy();
    expect(cancelReturnFunction).not.toHaveBeenCalled();
  });

  it("lets the customer back out without cancelling", async () => {
    const user = userEvent.setup();
    renderPanel(CANCELLABLE);

    await user.click(screen.getByRole("button", { name: es.cancel.button }));
    await user.click(screen.getByRole("button", { name: es.cancel.confirmNo }));

    expect(cancelReturnFunction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: es.cancel.button })).toBeTruthy();
  });
});

describe("after a successful cancellation", () => {
  it("shows the customer that it worked", async () => {
    // The regression that shipped: this text existed but was never visible.
    renderPanel(CANCELLABLE);
    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.doneTitle)).toBeTruthy();
    });
    expect(screen.getByText(es.cancel.doneBody)).toBeTruthy();
  });

  it("does NOT reload the page out from under them", async () => {
    // The exact defect: a synchronous reload unloaded the document before the
    // confirmation painted. The customer leaves when they choose to.
    //
    // This assertion, not the one above, is the real guard. Verified by putting
    // the reload back: this test and the startNew test failed, while "shows the
    // customer that it worked" still PASSED — a mocked reload cannot unload the
    // document, so the confirmation renders either way. Testing for the call is
    // the only way to catch it here.
    renderPanel(CANCELLABLE);
    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.doneTitle)).toBeTruthy();
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads only when the customer asks to start again", async () => {
    renderPanel(CANCELLABLE);
    const user = await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: es.cancel.startNew })).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: es.cancel.startNew }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("withdraws the cancel controls so it cannot be run twice", async () => {
    renderPanel(CANCELLABLE);
    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.doneTitle)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: es.cancel.button })).toBeNull();
    expect(screen.queryByRole("button", { name: es.cancel.confirmYes })).toBeNull();
  });
});

describe("when the cancellation does not succeed", () => {
  it("tells the customer instead of failing silently", async () => {
    // A rejected action used to set neither state, leaving a blank panel after
    // a click about the customer's money.
    cancelReturnFunction.mockRejectedValue(new Error("connection dropped"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderPanel(CANCELLABLE);

    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.failed)).toBeTruthy();
    });
  });

  it("uses the specific reason when eligibility changed under them", async () => {
    // The parcel got scanned between page render and click.
    cancelReturnFunction.mockResolvedValue({ ok: false, reason: "in-transit" });
    renderPanel(CANCELLABLE);

    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.blockedInTransit)).toBeTruthy();
    });
  });

  it("falls back to the generic message for a reason with no copy", async () => {
    cancelReturnFunction.mockResolvedValue({ ok: false, reason: "forbidden" });
    renderPanel(CANCELLABLE);

    await cancelAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(es.cancel.failed)).toBeTruthy();
    });
  });
});

describe("when the return may not be cancelled", () => {
  it("explains an in-transit parcel and offers no button", () => {
    renderPanel({ cancellable: false, reason: "in-transit" });

    expect(screen.getByText(es.cancel.blockedInTransit)).toBeTruthy();
    expect(screen.queryByRole("button", { name: es.cancel.button })).toBeNull();
  });

  it("explains a return an admin already settled", () => {
    renderPanel({ cancellable: false, reason: "already-settled" });

    expect(screen.getByText(es.cancel.blockedSettled)).toBeTruthy();
    expect(screen.queryByRole("button", { name: es.cancel.button })).toBeNull();
  });

  it("asks them to retry when we cannot reach the carrier", () => {
    renderPanel({ cancellable: false, reason: "carrier-unreadable" });

    expect(screen.getByText(es.cancel.blockedUnreadable)).toBeTruthy();
    expect(screen.queryByRole("button", { name: es.cancel.button })).toBeNull();
  });
});

describe("in English", () => {
  it("renders the English copy, not the Spanish", () => {
    renderPanel({ cancellable: false, reason: "in-transit" }, "en");

    expect(screen.getByText(en.cancel.blockedInTransit)).toBeTruthy();
    expect(screen.queryByText(es.cancel.blockedInTransit)).toBeNull();
  });
});
