// @vitest-environment jsdom

// The whole portal wizard, mounted for real: ClientOrder, every window, the
// summary and the submit button. Only the server actions are stubbed.
//
// #312875 (2026-11-24, reproduced end to end): a double-tap on the address
// step's Continue queued two `updateData` calls whose `prevState + 1` skipped
// the payout step, and the summary then showed "Reembolso tradicional" for a
// choice nobody made. A second route existed: self-booking, chosen on the
// summary AFTER the payout step, could make money come back. These tests pin
// the rule that closes both — no submit while a required payout is missing —
// through every route a customer can take.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const returnFunction = vi.fn();
vi.mock("@/actions/return", () => ({
  returnFunction: (...args: unknown[]) => returnFunction(...args),
}));

const saveAddress = vi.fn();
vi.mock("@/actions/updateOrder", () => ({
  saveAddress: (...args: unknown[]) => saveAddress(...args),
  updateOrder: vi.fn(),
  anularOrder: vi.fn(),
}));

import { en } from "@/lib/i18n/en";
vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

vi.mock("@/app/[id]/windows/header", () => ({ Header: () => null }));
vi.mock("@/app/[id]/components/trackingCapture", () => ({
  TrackingCapture: () => null,
}));

import { ClientOrder } from "@/app/[id]/clientOrder";
import { FeesProvider } from "@/app/[id]/feesContext";
import { DEFAULT_FEE_KEY, type FeeTable } from "@/lib/fees";
import type { OrderItem } from "@/types";

const ORDER_ID = "13577291399494";

function item(price: string): OrderItem {
  return {
    id: 1,
    lineItemId: "gid://shopify/LineItem/1",
    orderId: ORDER_ID,
    productId: "1",
    title: "Test product",
    variant_title: "M",
    variant_id: "1",
    price,
    quantity: 1,
    changed: false,
    action: "DEVOLUCIÓN",
    reason: "Me queda pequeño",
    notes: null,
    new_variant_title: null,
    new_variant_id: null,
    confirmed: false,
    return_id: null,
    refunded: null,
    credit: null,
    return_line_item_id: null,
    transaction_id: null,
    transaction_amount: null,
  };
}

// €5.00 return leg everywhere.
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: [{ maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 900 }],
};

const ORDER: any = {
  id: ORDER_ID,
  email: "customer@example.com",
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "Spain",
  shippingPhone: "600000000",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
  returnSubmittedAt: null,
  trackingSubmittedAt: null,
};

function portal(items: any[]) {
  return (
    <FeesProvider table={TABLE} order={ORDER}>
      <ClientOrder
        name="Ana"
        items={items}
        order={ORDER}
        id={ORDER_ID}
        allProducts={[]}
        statusPanel={null}
      />
    </FeesProvider>
  );
}

function renderPortal(price = "50.00") {
  return render(portal([item(price)]));
}

const heading = (text: string) => screen.queryByRole("heading", { name: text });
const continueButton = () => screen.getByRole("button", { name: en.common.continue });
const submitButton = () => screen.queryByRole("button", { name: en.common.updateOrder });

/** Resolve saveAddress by hand, so a second tap can land while the first is in flight. */
function deferredSave() {
  const pending: Array<() => void> = [];
  saveAddress.mockImplementation(
    () => new Promise((resolve) => pending.push(() => resolve({ ok: true })))
  );
  return { resolveAll: () => pending.splice(0).forEach((r) => r()) };
}

async function toAddress(user: ReturnType<typeof userEvent.setup>) {
  await user.click(continueButton());
  expect(heading(en.second.title)).not.toBeNull();
}

async function chooseSelfBooking(user: ReturnType<typeof userEvent.setup>) {
  const radio = screen
    .getByText(en.method.selfLabel)
    .closest("label")
    ?.querySelector('input[type="radio"]');
  await user.click(radio as Element);
}

beforeEach(() => {
  window.scrollTo = vi.fn() as any;
  saveAddress.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  returnFunction.mockReset();
  saveAddress.mockReset();
});

describe("the portal wizard", () => {
  it("a double-tap on the address step lands on the payout step, never the summary (#312875)", async () => {
    const user = userEvent.setup();
    const save = deferredSave();
    renderPortal();
    await toAddress(user);

    await user.dblClick(continueButton());
    await act(async () => save.resolveAll());

    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    expect(submitButton()).toBeNull();
  });

  // Not tested here: the address Continue being disabled while the save is in
  // flight. That relies on an async `startTransition` keeping isPending true,
  // which Next's bundled React canary supports and the plain react-dom 18.3.1
  // these tests run on does not. It is verified in the real-browser E2E
  // instead. The test above is the stronger guarantee anyway: it passes on a
  // React where the button never disables, because `addressSaved` is
  // idempotent.

  it("stays on the address step and says so when the save is refused", async () => {
    const user = userEvent.setup();
    saveAddress.mockResolvedValue({ ok: false, reason: "incomplete" });
    renderPortal();
    await toAddress(user);

    await user.click(continueButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.second.saveError));
    expect(heading(en.second.title)).not.toBeNull();
  });

  it("walks to the summary with the payout chosen and submits it", async () => {
    const user = userEvent.setup();
    renderPortal();
    await toAddress(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());

    await user.click(screen.getByText(en.third.originalPayment));
    await user.click(continueButton());

    expect(heading(en.last.title)).not.toBeNull();
    expect(heading(en.last.refundTitle)).not.toBeNull();
    await user.click(submitButton()!);
    expect(returnFunction).toHaveBeenCalledWith(ORDER_ID, false, "customer@example.com", "CORREOS");
  });

  // The second route: €4 back before a €5 fee. With our courier nothing comes
  // back, so there is no payout step; self-booking drops the return leg and
  // €4 comes back. The choice now lives on the address step, before the
  // payout step decides whether it exists.
  it("self-booking that makes money come back brings in the payout step", async () => {
    const user = userEvent.setup();
    renderPortal("4.00");
    await toAddress(user);
    await chooseSelfBooking(user);

    await user.click(continueButton());

    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    expect(submitButton()).toBeNull();
  });

  it("with our courier the same basket skips the payout step and shows no tender", async () => {
    const user = userEvent.setup();
    renderPortal("4.00");
    await toAddress(user);

    await user.click(continueButton());

    await waitFor(() => expect(heading(en.last.title)).not.toBeNull());
    expect(heading(en.third.title)).toBeNull();
    // Nothing comes back, so no "refund" or "credit" paragraph is claimed.
    expect(heading(en.last.refundTitle)).toBeNull();
    expect(heading(en.last.creditTitle)).toBeNull();
    await user.click(submitButton()!);
    expect(returnFunction).toHaveBeenCalledWith(ORDER_ID, null, "customer@example.com", "CORREOS");
  });

  it("self-booking is threaded to submit, and the total drops the return leg", async () => {
    const user = userEvent.setup();
    renderPortal();
    await toAddress(user);
    await chooseSelfBooking(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    await user.click(screen.getByText(en.third.originalPayment));
    await user.click(continueButton());

    // €50 back, not €45: the customer pays their own courier.
    expect(screen.queryByText("€45.00")).toBeNull();
    expect(screen.queryByText("-€5.00")).toBeNull();
    await user.click(submitButton()!);
    expect(returnFunction).toHaveBeenCalledWith(ORDER_ID, false, "customer@example.com", "SELF");
  });

  it("a server refusal for a missing payout returns to the payout step, not the crash screen", async () => {
    const user = userEvent.setup();
    returnFunction.mockResolvedValue({ ok: false, reason: "payout-required" });
    renderPortal();
    await toAddress(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    await user.click(screen.getByText(en.third.originalPayment));
    await user.click(continueButton());

    await user.click(submitButton()!);

    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    expect(submitButton()).toBeNull();
  });

  it("back from the summary returns to the payout step when one exists, else to the address", async () => {
    const user = userEvent.setup();
    renderPortal("4.00");
    await toAddress(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.last.title)).not.toBeNull());

    const back = document.querySelector("svg.cursor-pointer") as Element;
    await user.click(back);

    expect(heading(en.second.title)).not.toBeNull();
  });

  // Codex review, 2026-11-24: another tab changed the stored selection, so
  // this tab believed nothing was owed while the server knew money was. The
  // refusal revalidates (actions/return.ts); here the fresh selection arrives
  // as new props, and the payout step must follow from it.
  it("a refusal from a tab with a stale basket lands on the payout step once the server's basket arrives", async () => {
    const user = userEvent.setup();
    returnFunction.mockResolvedValue({ ok: false, reason: "payout-required" });
    const view = renderPortal("4.00");
    await toAddress(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.last.title)).not.toBeNull());

    await user.click(submitButton()!);
    await waitFor(() => expect(returnFunction).toHaveBeenCalled());
    view.rerender(portal([item("50.00")]));

    await waitFor(() => expect(heading(en.third.title)).not.toBeNull());
    expect(submitButton()).toBeNull();
  });

  // Codex review, 2026-11-24: clearing the only item used to keep the old
  // step, so picking again jumped straight back to the summary, past the
  // address step and the method choice.
  it("emptying the selection starts the walk over", async () => {
    const user = userEvent.setup();
    const view = renderPortal("4.00");
    await toAddress(user);
    await user.click(continueButton());
    await waitFor(() => expect(heading(en.last.title)).not.toBeNull());

    view.rerender(portal([{ ...item("4.00"), action: null, reason: null }]));
    view.rerender(portal([item("4.00")]));

    expect(heading(en.last.title)).toBeNull();
    expect(heading(en.second.title)).toBeNull();
    expect(continueButton()).toBeTruthy();
    expect(submitButton()).toBeNull();
  });
});

