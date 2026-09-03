// @vitest-environment jsdom

// Proves the delivery-address block genuinely omits its inputs when
// collapsed -- not hides them -- because updateData writes null to every
// delivery_* column when the block is absent from the submission, and that
// is exactly what clears a previously saved address. Hidden inputs would
// keep submitting it and the customer could never undo their choice.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { FeesProvider } from "@/app/[id]/feesContext";
import { DeliveryAddressFields } from "@/app/[id]/components/deliveryAddressFields";
import { LocaleProvider } from "@/lib/i18n/context";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, type FeeTable } from "@/lib/fees";

const flat = (returnFeeCents: number, exchangeFeeCents: number) => [
  { maxGrams: UNBOUNDED_MAX_GRAMS, returnFeeCents, exchangeFeeCents },
];
const TABLE: FeeTable = {
  [DEFAULT_FEE_KEY]: flat(9900, 12000),
  ES: flat(500, 850),
  US: flat(2200, 3496),
};
const ORDER = {
  shippingName: "Ana Ruiz",
  shippingAddress1: "Calle Mayor 1",
  shippingAddress2: null,
  shippingZip: "28013",
  shippingCity: "Madrid",
  shippingProvince: "Madrid",
  shippingCountry: "España",
  deliveryName: null,
  deliveryAddress1: null,
  deliveryAddress2: null,
  deliveryZip: null,
  deliveryCity: null,
  deliveryProvince: null,
  deliveryCountry: null,
} as any;

function mount() {
  return render(
    <LocaleProvider locale="en">
      <FeesProvider table={TABLE} order={ORDER}>
        <DeliveryAddressFields order={ORDER} />
      </FeesProvider>
    </LocaleProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe("DeliveryAddressFields", () => {
  it("renders collapsed, with no delivery inputs in the form", () => {
    mount();
    expect(screen.queryByLabelText(/delivery country/i)).toBeNull();
    // Nothing named delivery* may be submitted while it is collapsed.
    expect(document.querySelector('[name^="delivery"]')).toBeNull();
  });

  it("reveals the fields when the box is ticked", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(document.querySelector('[name="deliveryAddress1"]')).not.toBeNull();
    expect(document.querySelector('[name="deliveryCountry"]')).not.toBeNull();
  });

  // Unticking has to remove the inputs, so updateData writes nulls and clears
  // any stored address.
  it("removes the fields again when the box is unticked", () => {
    mount();
    const box = screen.getByRole("checkbox");
    fireEvent.click(box);
    fireEvent.click(box);
    expect(document.querySelector('[name^="delivery"]')).toBeNull();
  });

  it("offers only supported countries", () => {
    mount();
    fireEvent.click(screen.getByRole("checkbox"));
    const select = document.querySelector('[name="deliveryCountry"]') as HTMLSelectElement;
    const codes = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(codes).toContain("US");
    expect(codes).toContain("ES");
    expect(codes).not.toContain("Freedonia");
  });
});
