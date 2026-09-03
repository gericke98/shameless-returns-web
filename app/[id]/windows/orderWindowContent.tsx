import { useEffect, useMemo } from "react";
import { OrderItem, OrderWindowContentProps, Prices, Product } from "@/types";
import { FirstWindow } from "./firstWindow";
import { SecondWindow } from "./secondWindow";
import { ThirdWindow } from "./thirdWindow";
import { LastWindow } from "./lastWindow";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee, sameZone, type FeeLegs } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";

// Valuation comes from lib/basket.ts — the same function payments.ts charges
// from — so the `totalPrice > 0` branch that decides whether the refund-method
// step is shown at all agrees with what Stripe would bill.
const calculatePrices = (
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

export const OrderWindowContent = ({
  position,
  name,
  items,
  order,
  id,
  setPosition,
  setCredito,
  credito,
  method,
  setMethod,
  onItemChange,
  allProducts,
}: OrderWindowContentProps & { onItemChange?: (updatedItem: any) => void }) => {
  const fees = useFees();
  const { totalPrice } = useMemo(
    () => calculatePrices(items, allProducts, sameZone(fees)),
    [items, allProducts, fees]
  );
  const itemsToShow = useMemo(
    () => items.filter((item) => item.action && !item.confirmed),
    [items]
  );

  useEffect(() => {
    if (itemsToShow.length === 0 && position !== 1) {
      setPosition(1);
    }
  }, [itemsToShow, position, setPosition]);

  const windows = {
    1: (
      <FirstWindow
        name={name}
        items={items}
        onItemChange={onItemChange}
        allProducts={allProducts}
      />
    ),
    2: (
      <SecondWindow
        order={order}
        position={position}
        setPosition={setPosition}
        items={items}
        onItemChange={onItemChange}
        id={id}
        allProducts={allProducts}
      />
    ),
    3:
      totalPrice > 0 ? (
        <ThirdWindow
          items={items}
          shipping={true}
          position={position}
          setPosition={setPosition}
          setCredito={setCredito}
          onItemChange={onItemChange}
          id={id}
          credito={credito}
          allProducts={allProducts}
        />
      ) : null,
    4: (
      <LastWindow
        items={items}
        position={position}
        setPosition={setPosition}
        credito={credito}
        method={method}
        setMethod={setMethod}
        onItemChange={onItemChange}
        id={id}
        allProducts={allProducts}
      />
    ),
  };

  return windows[position as keyof typeof windows] || null;
};
