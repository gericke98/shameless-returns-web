// @vitest-environment jsdom

// #312973 (2026-11-20): the customer reached the summary (step 4), edited an
// item there, and pressed submit. Any basket change voids the payout choice
// (ClientOrder.handleItemChange — the #45 rule that a choice made for one total
// does not carry to another), but the wizard stayed on step 4. The submit then
// sent isCredit = null while money was owed back, the server refused it
// ("money is owed back but no payout was chosen"), and the throw inside
// AsyncButton's transition rendered app/error.tsx — "Algo ha salido mal".
//
// The invariant under test: once the payout choice is voided, the customer is
// never left on a step past it. They go back to step 3 and choose again.
//
// OrderWindow is replaced by a stub that exposes the three things ClientOrder
// hands it — the position, setCredito and onItemChange — so the test drives
// ClientOrder's own state, not the windows' rendering.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const returnFunction = vi.fn();
vi.mock("@/actions/return", () => ({
  returnFunction: (...args: unknown[]) => returnFunction(...args),
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
vi.mock("@/app/[id]/windows/orderWindow", () => ({
  OrderWindow: (props: any) => (
    <div>
      <p data-testid="position">{props.position}</p>
      <button onClick={() => props.setCredito(false)}>choose card refund</button>
      <button onClick={() => props.onItemChange?.({})}>edit an item</button>
    </div>
  ),
}));

import { ClientOrder } from "@/app/[id]/clientOrder";
import { FeesProvider } from "@/app/[id]/feesContext";
import { DEFAULT_FEE_KEY, type FeeTable } from "@/lib/fees";
import type { OrderItem } from "@/types";

// One 50.00 return with a 5.00 leg: 45.00 comes back, so a payout is required.
const ITEM: OrderItem = {
  id: 1,
  lineItemId: "gid://shopify/LineItem/1",
  orderId: "13577291399494",
  productId: "1",
  title: "Test product",
  variant_title: "M",
  variant_id: "1",
  price: "50.00",
  quantity: 1,
  changed: false,
  action: "DEVOLUCIÓN",
  reason: null,
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

const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: [
    { maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 900 },
  ],
};

const ORDER: any = {
  id: "13577291399494",
  email: "customer@example.com",
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "Spain",
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

function renderPortal() {
  return render(
    <FeesProvider table={TABLE} order={ORDER}>
      <ClientOrder
        name="Ana"
        items={[ITEM]}
        order={ORDER}
        id={ORDER.id}
        allProducts={[]}
        statusPanel={null}
      />
    </FeesProvider>
  );
}

const position = () => screen.getByTestId("position").textContent;
const continueButton = () => screen.getByRole("button", { name: en.common.continue });

/** Walks to the summary the way a customer does, choosing card refund on step 3. */
async function reachSummary(user: ReturnType<typeof userEvent.setup>) {
  await user.click(continueButton()); // 1 -> 2
  await user.click(continueButton()); // 2 -> 3 (hidden on step 2, still clickable in jsdom)
  await user.click(screen.getByRole("button", { name: "choose card refund" }));
  await user.click(continueButton()); // 3 -> 4
  expect(position()).toBe("4");
}

afterEach(() => {
  cleanup();
  returnFunction.mockReset();
});

describe("a basket change on the summary voids the payout choice", () => {
  it("sends the customer back to the payout step instead of letting them submit without one", async () => {
    const user = userEvent.setup();
    renderPortal();
    await reachSummary(user);

    await user.click(screen.getByRole("button", { name: "edit an item" }));

    expect(position()).toBe("3");
    expect(screen.queryByRole("button", { name: en.common.updateOrder })).toBeNull();
    expect(returnFunction).not.toHaveBeenCalled();
  });

  it("submits the choice made again on step 3", async () => {
    const user = userEvent.setup();
    renderPortal();
    await reachSummary(user);

    await user.click(screen.getByRole("button", { name: "edit an item" }));
    await user.click(screen.getByRole("button", { name: "choose card refund" }));
    await user.click(continueButton());
    await user.click(screen.getByRole("button", { name: en.common.updateOrder }));

    expect(returnFunction).toHaveBeenCalledWith(
      ORDER.id,
      false,
      "customer@example.com",
      "CORREOS"
    );
  });

  it("leaves earlier steps where they are", async () => {
    const user = userEvent.setup();
    renderPortal();
    await user.click(continueButton()); // 1 -> 2

    await user.click(screen.getByRole("button", { name: "edit an item" }));

    expect(position()).toBe("2");
  });
});
