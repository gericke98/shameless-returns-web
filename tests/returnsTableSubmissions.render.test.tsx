// @vitest-environment jsdom

// Finding 10: the dashboard groups and labels settlement actions by the
// SUBMISSION a click executes, never by order. Two exchange submissions on one
// order are two parcels and two replacement orders: one button per
// submission, each settling a row of its own submission.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const clicked: number[] = [];
vi.mock("@/actions/refund", () => ({
  validateReturn: async (product: any) => {
    clicked.push(product.id);
  },
}));

const ORDER = {
  id: "100",
  orderNumber: "#311000",
  email: "c@example.com",
  shippingName: "Ana",
  locator: null,
  carrier: "dhl",
  returnStatus: null,
  products: [],
};
const STATUS = { label: "En tránsito", phase: "en_transito" } as any;

const row = (id: number, settlementKey: string, action = "CAMBIO") => ({
  order: ORDER,
  status: STATUS,
  product: {
    id,
    settlementKey,
    title: `Garment ${id}`,
    variant_title: "M",
    quantity: 1,
    price: "50.00",
    action,
    refunded: false,
    new_variant_title: null,
    new_product_info: null,
  },
});

afterEach(() => {
  cleanup();
  clicked.length = 0;
});

describe("ReturnsTable settlement actions", () => {
  it("renders one exchange action PER SUBMISSION, each settling its own submission's row", async () => {
    const { default: ReturnsTable } = await import("@/app/dashboard/components/ReturnsTable");
    render(
      <ReturnsTable
        returns={[
          row(1, "submission:A"),
          row(2, "submission:B"),
          row(3, "submission:A"),
          row(4, "submission:B"),
        ] as any}
      />
    );
    const buttons = screen.getAllByRole("button", { name: /Process the exchange/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Process the exchange submission:A for #311000 — 2 garments in one order",
      "Process the exchange submission:B for #311000 — 2 garments in one order",
    ]);
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(clicked).toEqual([1, 2]);
  });

  it("a lone exchange line of a submission keeps its own row button", async () => {
    const { default: ReturnsTable } = await import("@/app/dashboard/components/ReturnsTable");
    render(<ReturnsTable returns={[row(1, "submission:A"), row(2, "submission:B")] as any} />);
    expect(screen.queryAllByRole("button", { name: /Process the exchange/ })).toEqual([]);
    expect(screen.getAllByRole("button", { name: /^Refund Garment/ })).toHaveLength(2);
  });

  it("shows a line's total, rounded once: 2 units stored at 15.505 are 31.01 €, never 15.505 or 31.02", async () => {
    const { default: ReturnsTable } = await import("@/app/dashboard/components/ReturnsTable");
    const r = row(1, "submission:A", "DEVOLUCIÓN");
    r.product = { ...r.product, quantity: 2, price: "15.505" };
    render(<ReturnsTable returns={[r] as any} />);
    expect(screen.getByRole("columnheader", { name: "Line total" })).toBeTruthy();
    expect(screen.getByText("31.01 €")).toBeTruthy();
    expect(screen.queryByText(/15\.505/)).toBeNull();
  });
});
