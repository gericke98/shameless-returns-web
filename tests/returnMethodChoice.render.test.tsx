// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReturnMethodChoice } from "@/app/[id]/components/returnMethodChoice";

vi.mock("@/lib/i18n/context", () => ({
  useT: () => ({
    method: {
      ourLabel: "We ship it",
      selfLabel: "I'll ship it myself",
      selfHint: "You arrange the courier and pay the postage.",
      free: "free",
    },
  }),
  useLocale: () => "en",
}));

describe("ReturnMethodChoice", () => {
  it("offers self-booking when our return leg costs money", () => {
    render(
      <ReturnMethodChoice value="AMPHORA" onChange={() => {}} returnLegCents={650} />
    );

    expect(screen.getByText("I'll ship it myself")).toBeTruthy();
  });

  it("renders nothing at all when our own leg is free", () => {
    // Offering it here could only cost them more.
    const { container } = render(
      <ReturnMethodChoice value="CORREOS" onChange={() => {}} returnLegCents={0} />
    );

    expect(container.textContent).toBe("");
  });
});
