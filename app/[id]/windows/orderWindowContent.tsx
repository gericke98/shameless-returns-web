import { useEffect, useMemo } from "react";
import { OrderItem, OrderWindowContentProps, Prices } from "@/types";
import { FirstWindow } from "./firstWindow";
import { SecondWindow } from "./secondWindow";
import { ThirdWindow } from "./thirdWindow";
import { LastWindow } from "./lastWindow";

const calculatePrices = (items: OrderItem[]): Prices => {
  const returnPrice = items
    .filter((item) => item.action && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const exchangePrice = items
    .filter((item) => item.action === "CAMBIO" && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  return {
    returnPrice,
    exchangePrice,
    totalPrice: returnPrice - exchangePrice,
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
  onItemChange,
}: OrderWindowContentProps & { onItemChange?: (updatedItem: any) => void }) => {
  const { totalPrice } = useMemo(() => calculatePrices(items), [items]);
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
    1: <FirstWindow name={name} items={items} onItemChange={onItemChange} />,
    2: (
      <SecondWindow
        order={order}
        position={position}
        setPosition={setPosition}
        items={items}
        onItemChange={onItemChange}
        id={id}
      />
    ),
    3:
      totalPrice !== 0 ? (
        <ThirdWindow
          items={items}
          shipping={true}
          position={position}
          setPosition={setPosition}
          setCredito={setCredito}
          onItemChange={onItemChange}
          id={id}
        />
      ) : null,
    4: (
      <LastWindow
        items={items}
        position={position}
        setPosition={setPosition}
        credito={credito}
        onItemChange={onItemChange}
        id={id}
      />
    ),
  };

  return windows[position as keyof typeof windows] || null;
};
