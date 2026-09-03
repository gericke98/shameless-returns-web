// @vitest-environment jsdom

// Spec §4: the delivery-address block is offered ONLY when the basket
// contains an exchange -- a pure return has no replacement to deliver, and
// offering the choice there would let a customer raise their own price for
// nothing. That gate (`hasExchange &&` in secondWindowForm.tsx) had zero
// coverage: deleting it left all 1001 tests green. This pins it directly.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// SecondWindowForm calls useFormState(updateData, position). The real
// updateData ("use server") pulls in db/queries.ts and friends; stub it the
// same way tests/returnMethodThreading.render.test.tsx stubs the sibling
// action, since nothing here exercises an actual submission.
vi.mock("@/actions/updateOrder", () => ({
  updateData: (state: number) => state,
}));

// The installed react-dom (18.3.1, plain npm) does not export useFormState --
// that hook is only supplied by Next's patched react-dom at build/runtime.
// Plain vitest resolves the unpatched package, so it has to be shimmed the
// same way tests/anularOrder.test.ts shims React's `cache()` for the same
// class of reason. The shim never runs the action; nothing here submits.
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    useFormState: (action: unknown, initialState: unknown) => [
      initialState,
      action,
    ],
  };
});

import { SecondWindowForm } from "@/app/[id]/components/secondWindowForm";
import { FeesProvider } from "@/app/[id]/feesContext";
import { LocaleProvider } from "@/lib/i18n/context";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import { ACTIONS } from "@/placeholder";
import type { productsOrder } from "@/db/schema";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
};

const ORDER = {
  id: "13217168851270",
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "España",
  shippingPhone: "600000000",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} satisfies OrderAddressFields & { id: string; shippingPhone: string };

/** A minimal productsorder row. Only the fields SecondWindowForm's tree
 *  actually reads (valueBasket, the `hasExchange` filter) are meaningful;
 *  the rest are filled in so the row type-checks. */
function line(overrides: Partial<typeof productsOrder.$inferSelect>) {
  return {
    id: 1,
    orderId: ORDER.id,
    productId: "1",
    title: "Test product",
    variant_title: "M",
    variant_id: "1",
    price: "50.00",
    quantity: 1,
    changed: false,
    action: null,
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
    ...overrides,
  } as unknown as typeof productsOrder.$inferSelect;
}

function mount(items: (typeof productsOrder.$inferSelect)[]) {
  return render(
    <LocaleProvider locale="en">
      <FeesProvider table={TABLE} order={ORDER}>
        <SecondWindowForm
          order={ORDER as any}
          position={2}
          setPosition={() => {}}
          items={items}
          allProducts={[]}
        />
      </FeesProvider>
    </LocaleProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("SecondWindowForm — the delivery block's exchange gate", () => {
  it("renders no delivery inputs and no disclosure checkbox for a DEVOLUCIÓN-only basket", () => {
    mount([line({ action: ACTIONS.RETURN, confirmed: false })]);

    expect(document.querySelector('[name^="delivery"]')).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renders the disclosure checkbox for a basket with an unconfirmed CAMBIO line", () => {
    mount([line({ action: ACTIONS.CHANGE, confirmed: false })]);

    expect(screen.getByRole("checkbox")).not.toBeNull();
  });
});
