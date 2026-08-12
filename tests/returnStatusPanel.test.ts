import { describe, expect, it, vi } from "vitest";

// `returnStatusPanel.tsx` imports `cancelReturnFunction` from
// `@/actions/cancelReturn`, which pulls in `db/queries` -> `db/drizzle`, which
// calls `neon(process.env.DATABASE_URL!)` at module load time. That throws in
// this process because DATABASE_URL isn't set for `vitest run` (only
// `cancelReturn.test.ts` needs it, and mocks `@/db/queries` directly for that
// reason). This test only exercises the pure `blockedMessageKey` export, so
// the action is mocked here purely to keep module import from touching a
// database connection — never to change what's asserted below.
vi.mock("@/actions/cancelReturn", () => ({
  cancelReturnFunction: vi.fn(),
}));

import { blockedMessageKey } from "@/app/[id]/components/returnStatusPanel";

// Which explanation a customer sees when they cannot cancel. Split out from the
// component so the mapping is testable without rendering: a wrong branch here
// tells someone their parcel is in transit when we actually already refunded
// them.

describe("blockedMessageKey", () => {
  it("explains a parcel already with the carrier", () => {
    expect(blockedMessageKey("in-transit")).toBe("blockedInTransit");
  });

  it("explains a return an admin has already settled", () => {
    expect(blockedMessageKey("already-settled")).toBe("blockedSettled");
  });

  it("asks the customer to retry when the carrier is unreachable", () => {
    expect(blockedMessageKey("carrier-unreadable")).toBe("blockedUnreadable");
  });

  it("has no message when there is simply no return", () => {
    // The panel is not rendered at all in this case.
    expect(blockedMessageKey("no-return")).toBeNull();
  });
});
