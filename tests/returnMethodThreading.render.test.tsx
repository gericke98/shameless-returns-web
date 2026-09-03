// @vitest-environment jsdom

// Proves the customer's choice on the summary screen actually reaches the
// submit button, not just that the choice control renders.
//
// LastWindow (which hosts ReturnMethodChoice) and AsyncButton are SIBLINGS
// under app/[id]/clientOrder.tsx, not ancestor/descendant — a choice made in
// one does not automatically reach the other. `method` state is lifted to
// ClientOrder (the lowest common ancestor) and threaded down through
// OrderWindow -> OrderWindowContent -> LastWindow as a plain prop, and passed
// straight to AsyncButton. This test wires the same two leaves the same way
// ClientOrder does — state above both, passed down as props — and drives a
// real click through LastWindow's real ReturnMethodChoice to a real
// AsyncButton, asserting the claim that reaches returnFunction is "SELF".
//
// The dumb pass-through layers (OrderWindow, OrderWindowContent) are not
// exercised here; they are covered by their prop types instead. `method` and
// `setMethod` are REQUIRED (not optional) fields on ClientOrderWindowContentProps
// and OrderWindowContentProps in types/index.ts, so a pass-through that drops
// them fails `tsc --noEmit`, not just a runtime assertion.

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const returnFunction = vi.fn();
vi.mock("@/actions/return", () => ({
  returnFunction: (...args: unknown[]) => returnFunction(...args),
}));

// LastWindow's tree pulls in ProductLineClient -> dialogForm -> this module,
// which imports db/drizzle.ts and throws at import time without a live
// DATABASE_URL. Nothing in this test exercises the edit dialog (ITEM has no
// `newp`, so ProductLineClient never actually renders it), so a stub is
// enough to stop the real module — and its db import — from ever loading.
vi.mock("@/actions/updateOrder", () => ({
  updateOrder: vi.fn(),
  anularOrder: vi.fn(),
}));

// The real English dictionary — not a hand-picked stub — so every key that
// LastWindow, SummaryComponent, and AsyncButton read (t.last.*, t.summary.*,
// t.method.*, t.common.*) is genuinely present, the same guarantee the app
// gets in production.
import { en } from "@/lib/i18n/en";
vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

import { LastWindow } from "@/app/[id]/windows/lastWindow";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { FeesProvider } from "@/app/[id]/feesContext";
import type { ReturnMethod } from "@/lib/returnMethods";
import { DEFAULT_FEE_KEY, type CountryBands, type FeeTable } from "@/lib/fees";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import type { OrderItem } from "@/types";

// One returnable item worth enough that the return leg costs money — the
// gate ReturnMethodChoice checks (selfBookingOffered) is on returnLegCents,
// so a free leg would make it render nothing and there would be nothing to
// click.
const ITEM: OrderItem = {
  id: 1,
  lineItemId: "gid://shopify/LineItem/1",
  orderId: "13217168851270",
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
  gift_card_id: null,
  return_line_item_id: null,
  transaction_id: null,
  transaction_amount: null,
};

// A single unbounded band with a non-zero return fee, so resolveFee reports
// returnLegCents > 0 for the basket above.
const FEES: CountryBands = [
  { maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 900 },
];

// Only the '*' row is populated, and ORDER's country is not a key in TABLE,
// so feesForCountry falls back to it for both legs -- reproducing the old
// `sameZone(FEES)` fixture exactly, since there is no separate delivery
// address either.
const TABLE: FeeTable = { [DEFAULT_FEE_KEY]: FEES };
const ORDER = {
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "US",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} satisfies OrderAddressFields;

/**
 * The slice of app/[id]/clientOrder.tsx that matters here: `method` state
 * held above both leaves, passed down as plain props — exactly how
 * ClientOrder wires OrderWindow (-> ... -> LastWindow) and AsyncButton today.
 */
function Harness() {
  const [method, setMethod] = useState<ReturnMethod>("CORREOS");
  return (
    <FeesProvider table={TABLE} order={ORDER}>
      <LastWindow
        items={[ITEM]}
        position={4}
        setPosition={() => {}}
        credito={false}
        method={method}
        setMethod={setMethod}
        id="13217168851270"
        allProducts={[]}
      />
      <AsyncButton
        text="Submit"
        id="13217168851270"
        isCredit={false}
        email="customer@example.com"
        method={method}
      />
    </FeesProvider>
  );
}

afterEach(() => {
  cleanup();
  returnFunction.mockReset();
});

describe("the method thread from the summary screen to submit", () => {
  it("sends SELF when the customer chooses to ship it themselves", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const selfLabel = screen.getByText(en.method.selfLabel);
    const selfRadio = selfLabel
      .closest("label")
      ?.querySelector('input[type="radio"]');
    expect(selfRadio).toBeTruthy();
    await user.click(selfRadio as Element);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(returnFunction).toHaveBeenCalledWith(
      "13217168851270",
      false,
      "customer@example.com",
      "SELF"
    );
  });

  it("shows one total, not two, when the customer chooses to ship it themselves", async () => {
    // LastWindow computes its own total in a useMemo and renders
    // <SummaryComponent> two lines below the choice control. Until
    // SummaryComponent was given `method` it computed the fee its own way, so
    // the "Total refund" box and the refund paragraph beneath it disagreed by
    // exactly the return leg — and the box itemised a return-shipping charge
    // the customer is not paying.
    //
    // One 50.00 item, a 5.00 return leg, pure return: our lane refunds 45.00,
    // SELF refunds the full 50.00.
    const user = userEvent.setup();
    render(<Harness />);

    // The control half first, before anything is clicked: the total box and the
    // refund paragraph both say 45.00, and the return leg is itemised.
    expect(screen.getAllByText("€45.00")).toHaveLength(2);
    expect(screen.getAllByText("-€5.00")).toHaveLength(1);

    const selfLabel = screen.getByText(en.method.selfLabel);
    const selfRadio = selfLabel
      .closest("label")
      ?.querySelector('input[type="radio"]');
    await user.click(selfRadio as Element);

    // The box and the paragraph, both now stating the same, undocked number.
    // (The third 50.00 is the "Items to return" subtotal, which never moved.)
    expect(screen.queryByText("€45.00")).toBeNull();
    expect(screen.getAllByText("€50.00")).toHaveLength(3);
    // And the return-shipping line is gone rather than shown at zero: the
    // customer is paying their own courier for that leg.
    expect(screen.queryByText("-€5.00")).toBeNull();
    expect(screen.queryByText("-€0.00")).toBeNull();
  });

  it("still sends the default lane when the customer changes nothing", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(returnFunction).toHaveBeenCalledWith(
      "13217168851270",
      false,
      "customer@example.com",
      "CORREOS"
    );
  });
});
