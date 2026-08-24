// @vitest-environment jsdom

// WHEN the tracking-capture panel is offered, which is a different question
// from "is this a self-booked order".
//
// `returnMethod` is written BEFORE the Stripe redirect and — until the reset
// was fixed — was never cleared, so gating on it alone showed the panel forever
// to a customer who abandoned checkout or cancelled. That is not merely
// cosmetic: `submitReturnTracking` only checks `returnMethod === "SELF"`, so it
// would accept the submission, write tracking onto an order with no return, and
// fire an `approveAmphoraReturn` 404 into a false ops alert.
//
// The honest gate is the pair of facts that describe the state: a self-booked
// return HAS been submitted, and its tracking has NOT.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

// The panel itself is rendered in full by trackingCapture.render.test.tsx.
// Here it only has to be identifiable, and its real module imports a server
// action that pulls in the database.
vi.mock("@/app/[id]/components/trackingCapture", () => ({
  TrackingCapture: ({ id }: { id: string }) => (
    <div data-testid="tracking-capture">{id}</div>
  ),
}));

// The wizard below the panel is not what this test is about, and its real tree
// reaches db/drizzle through the edit dialog.
vi.mock("@/app/[id]/windows/orderWindow", () => ({
  OrderWindow: () => <div data-testid="wizard" />,
}));
vi.mock("@/app/[id]/components/buttons/asyncButton", () => ({
  AsyncButton: () => <button type="button">Submit</button>,
}));
vi.mock("@/app/[id]/windows/header", () => ({ Header: () => <div /> }));

import { en } from "@/lib/i18n/en";
vi.mock("@/lib/i18n/context", () => ({
  useT: () => en,
  useLocale: () => "en",
}));

import { ClientOrder } from "@/app/[id]/clientOrder";

/** The order row, in whatever state the case under test needs. */
function renderOrder(over: Record<string, any>) {
  const order = {
    id: "13221047697734",
    email: "customer@example.com",
    returnMethod: null,
    locator: null,
    returnSubmittedAt: null,
    trackingSubmittedAt: null,
    ...over,
  };
  render(
    <ClientOrder
      name="Ferran"
      items={[]}
      order={order as any}
      id={order.id}
      allProducts={[]}
    />
  );
}

const panel = () => screen.queryByTestId("tracking-capture");

describe("the tracking-capture panel", () => {
  it("is offered once a self-booked return has been submitted", () => {
    renderOrder({
      returnMethod: "SELF",
      returnSubmittedAt: new Date("2026-08-20T10:00:00Z"),
    });

    expect(panel()).toBeTruthy();
  });

  it("is not offered to a customer who chose SELF and never submitted", () => {
    // `returnMethod` is written before the Stripe redirect, so this is exactly
    // what an abandoned checkout looks like. There is no return, and
    // submitReturnTracking would nonetheless accept a tracking number for it.
    renderOrder({ returnMethod: "SELF", returnSubmittedAt: null });

    expect(panel()).toBeNull();
  });

  it("is withdrawn once the customer has given us their tracking number", () => {
    renderOrder({
      returnMethod: "SELF",
      returnSubmittedAt: new Date("2026-08-20T10:00:00Z"),
      trackingSubmittedAt: new Date("2026-08-21T09:00:00Z"),
      locator: "JD0123456789",
    });

    expect(panel()).toBeNull();
  });

  it("is never offered on a return we booked ourselves", () => {
    renderOrder({ returnMethod: "CORREOS", locator: "PQ1ES" });

    expect(panel()).toBeNull();
  });
});
