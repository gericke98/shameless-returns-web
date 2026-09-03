// @vitest-environment jsdom

// FeesProvider used to receive one country's resolved bands, computed on the
// server at page load. That cannot price a SECOND country the customer picks
// in the browser -- the whole point of this feature -- so it now carries the
// entire fee table plus the customer's in-progress delivery draft, and
// resolves legs itself. This proves: no draft prices from the stored order,
// setting a draft reprices the delivery leg only, and clearing the draft
// falls back to the stored address.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { FeesProvider, useFeeLegs, useDeliveryDraft } from "@/app/[id]/feesContext";
import { DEFAULT_FEE_KEY, UNBOUNDED_MAX_GRAMS, resolveFee, type FeeTable } from "@/lib/fees";

// This suite's config does not enable Vitest's `globals` option, so
// @testing-library/react's own auto-cleanup (which only registers when it
// finds a global `afterEach`) never fires -- unlike Jest defaults. Each `it`
// below renders a fresh tree in the same jsdom document, so without an
// explicit cleanup a later `getByTestId` matches every prior render's node
// too. Same pattern as tests/returnMethodThreading.render.test.tsx.
afterEach(cleanup);

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

let setDraftRef: (d: any) => void = () => {};

function Probe() {
  const legs = useFeeLegs();
  const { setDraft } = useDeliveryDraft();
  setDraftRef = setDraft;
  const { feeCents } = resolveFee(legs, { hasItems: true, netAmount: 0, grams: 500 });
  return <span data-testid="fee">{feeCents}</span>;
}

describe("FeesProvider", () => {
  it("prices both legs in the collection zone with no draft", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    expect(screen.getByTestId("fee").textContent).toBe("850");
  });

  it("reprices the outbound leg when a delivery draft is set", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    act(() => {
      setDraftRef({
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      });
    });
    // 500 collected in Spain + 1296 delivered to the US.
    expect(screen.getByTestId("fee").textContent).toBe("1796");
  });

  it("returns to the collection zone when the draft is cleared", () => {
    render(
      <FeesProvider table={TABLE} order={ORDER}>
        <Probe />
      </FeesProvider>
    );
    act(() => {
      setDraftRef({
        name: "Ana Ruiz",
        address1: "120 Broadway",
        address2: null,
        zip: "10271",
        city: "New York",
        province: "NY",
        country: "US",
      });
    });
    act(() => setDraftRef(null));
    expect(screen.getByTestId("fee").textContent).toBe("850");
  });
});
