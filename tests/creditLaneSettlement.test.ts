import { beforeEach, describe, expect, it, vi } from "vitest";

// Settling a store-credit return has to leave TWO systems correct, and until
// now it only left one.
//
//   1. The customer is paid — `giftCardCreate` mints a card. Always worked.
//   2. Shopify is told the goods came back. Never happened at all.
//
// With only (1), the order keeps reading `PAID` with `totalRefunded 0.00` and
// `refunds: []` forever, so the returned garment still counts as revenue. The
// money lane does this correctly via `returnRefund`; the credit lane simply
// skipped it. Order #311449 (Borja Bueno, settled 2026-08-24) is the row that
// showed it: gift card EUR 37.41 issued, Shopify refund record absent.
//
// The refund that fixes it must move NO money — the customer was paid in store
// credit, and charging the card as well would pay them twice.

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (fn: unknown) => fn,
}));

const ORDER: Record<string, any> = {};
const session = { value: { user: { role: "admin" } } as unknown };
vi.mock("next-auth", () => ({ getServerSession: async () => session.value }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

const giftCards: Array<{ value: number; orderId: string; variantId: string }> = [];
const moneyRefunds: number[] = [];
const creditRefunds: Array<{ returnId: string; returnLineItemId: string }> = [];
const closed: string[] = [];

const creditRefundResult = { value: { success: true } as { success: boolean } };

vi.mock("@/db/queries", () => ({
  getOrderById: async () => ORDER,
  getOrderByIdFresh: async () => ORDER,
  getOrderTotal: async () => ({ id: ORDER.id, customer: { id: "c1" } }),
  processGiftCardReturn: async (
    _customerId: string,
    value: number,
    variantId: string,
    orderId: string
  ) => {
    giftCards.push({ value, orderId, variantId });
    return { success: true };
  },
  createRefund: async (_r: string, _l: string, _t: string, amount: number) => {
    moneyRefunds.push(amount);
    return { success: true };
  },
  createStoreCreditRefund: async (returnId: string, returnLineItemId: string) => {
    creditRefunds.push({ returnId, returnLineItemId });
    return creditRefundResult.value;
  },
  createOrder: async () => ({ success: true }),
  closeReturn: async (id: string) => {
    closed.push(id);
    return { success: true };
  },
}));

const BANDS = [{ maxGrams: 2147483647, returnFeeCents: 500, exchangeFeeCents: 850 }];
vi.mock("@/db/fees", () => ({ getFeeTable: async () => ({ "*": BANDS }) }));
vi.mock("@/lib/loadBasket", () => ({
  loadBasket: async () => ({
    order: ORDER,
    discountedProducts: [],
    basket: { hasItems: true, netAmount: 37.53, grams: 423 },
  }),
}));
vi.mock("@/actions/exchangeReservation", () => ({
  releaseExchangeReservation: async () => {},
  reserveExchangeStock: async () => {},
}));
vi.mock("@/lib/orderAccess", () => ({ hasOrderAccess: async () => true }));

const opsAlerts: Array<{ subject: string; body: string }> = [];
vi.mock("@/actions/opsAlert", () => ({
  alertOps: async (subject: string, body: string) => {
    opsAlerts.push({ subject, body });
  },
}));

const dbLine = { value: null as null | Record<string, unknown> };
vi.mock("@/db/drizzle", () => {
  const chain: any = {
    update: () => chain,
    set: () => chain,
    where: () => Promise.resolve(),
    select: () => chain,
    from: () => Promise.resolve([]),
    query: {
      productsOrder: {
        findFirst: async () => dbLine.value,
        findMany: async () => [],
      },
    },
  };
  return { default: chain };
});

async function settleLine(product: Record<string, any>) {
  const { validateReturn } = await import("@/actions/refund");
  await validateReturn(product, "any", { id: ORDER.id });
}

const LINE = {
  variant_id: "55865099551046",
  price: "37.53",
  return_id: "gid://shopify/Return/57102303558",
  return_line_item_id: "gid://shopify/ReturnLineItem/88545198406",
  transaction_id: "gid://shopify/OrderTransaction/14867690783046",
};

beforeEach(() => {
  giftCards.length = 0;
  moneyRefunds.length = 0;
  creditRefunds.length = 0;
  closed.length = 0;
  opsAlerts.length = 0;
  creditRefundResult.value = { success: true };
  session.value = { user: { role: "admin" } };
  for (const key of Object.keys(ORDER)) delete ORDER[key];
  Object.assign(ORDER, {
    id: "13253700485446",
    orderNumber: "#311449",
    shippingCountry: "Spain",
    shippingZip: "46530",
    returnMethod: null,
    products: [],
  });
  dbLine.value = {
    id: 976,
    orderId: "13253700485446",
    variant_id: "55865099551046",
    price: "37.53",
    credit: true,
    action: "DEVOLUCIÓN",
    refunded: false,
    return_id: LINE.return_id,
    return_line_item_id: LINE.return_line_item_id,
  };
});

describe("settling a store-credit return", () => {
  it("records the return as refunded on Shopify", async () => {
    // The whole point. Without this call the order stays PAID at 0.00
    // refunded even though the garment is back on the shelf.
    await settleLine(LINE);

    expect(creditRefunds).toEqual([
      {
        returnId: LINE.return_id,
        returnLineItemId: LINE.return_line_item_id,
      },
    ]);
  });

  it("still mints the gift card, at the price less the return leg plus 15%", async () => {
    // The control: recording the refund must not disturb what the customer is
    // actually paid. (37.53 - 5.00) * 1.15 = 37.41, the figure the portal
    // showed and the card Shopify issued.
    await settleLine(LINE);

    expect(giftCards).toHaveLength(1);
    expect(giftCards[0].value).toBeCloseTo(37.41, 2);
  });

  it("never charges the card as well — store credit moves no money", async () => {
    // `createRefund` is the money lane. Calling it here would refund the
    // customer to their card AND hand them a gift card for the same garment.
    await settleLine(LINE);

    expect(moneyRefunds).toEqual([]);
  });

  it("records the refund before closing the return", async () => {
    await settleLine(LINE);

    expect(creditRefunds).toHaveLength(1);
    expect(closed).toEqual([LINE.return_id]);
  });

  it("scopes the gift card to this order, not to every order sharing the variant", async () => {
    // `processGiftCardReturn` used to stamp `gift_card_id` by variant alone.
    // Settling #311449 wrote Borja's card id onto Marcos G. Merino's row on
    // #310927 — a different customer, a settled money refund, same garment.
    await settleLine(LINE);

    expect(giftCards[0]).toMatchObject({
      orderId: "13253700485446",
      variantId: "55865099551046",
    });
  });
});

describe("when Shopify refuses the refund record", () => {
  // The card is already minted at this point, so the choice is between a
  // wrong revenue figure and a second gift card. It must never be the second.
  beforeEach(() => {
    creditRefundResult.value = { success: false };
  });

  it("still closes and marks the line, so a retry cannot mint a second card", async () => {
    await settleLine(LINE);

    expect(closed).toEqual([LINE.return_id]);
  });

  it("tells ops by email, with the ids needed to fix it by hand", async () => {
    // `console.error` is not a record — Vercel drops runtime logs after about
    // an hour, and this one needs a human tomorrow.
    await settleLine(LINE);

    expect(opsAlerts).toHaveLength(1);
    expect(opsAlerts[0].subject).toContain("13253700485446");
    expect(opsAlerts[0].body).toContain(LINE.return_id);
    expect(opsAlerts[0].body).toContain(LINE.return_line_item_id);
  });

  it("does not fall back to charging the card", async () => {
    await settleLine(LINE);

    expect(moneyRefunds).toEqual([]);
  });
});
