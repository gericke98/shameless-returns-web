// The portal's running total, in euros. Pure: no db, no React.
//
// Valuation comes from lib/basket.ts — the same function payments.ts charges
// from — so the `totalPrice > 0` branch that decides whether the payout step is
// shown at all (OrderWindowContent) and whether a payout choice is required
// (ClientOrder) agree with each other and with what Stripe would bill.
import type { OrderItem, Prices, Product } from "@/types";
import { centsToEuros, resolveFee, type FeeLegs } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";

export const calculatePrices = (
  items: OrderItem[],
  allProducts: Product[],
  legs: FeeLegs
): Prices => {
  const basket = valueBasket(items, allProducts);
  const { feeCents } = resolveFee(legs, basket);
  return {
    returnPrice: basket.returnPrice,
    exchangePrice: basket.exchangePrice,
    totalPrice: basket.netAmount - centsToEuros(feeCents),
  };
};
