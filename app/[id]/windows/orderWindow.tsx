"use client";
import { orders, productsOrder } from "@/db/schema";
import { OrderItem, Product2 } from "@/types";
import { useState } from "react";
import { LastWindow } from "./lastWindow";
import { FirstWindow } from "./firstWindow";
import { SecondWindow } from "./secondWindow";
import { ThirdWindow } from "./thirdWindow";

interface ClientOrderProps {
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  setPosition?: React.Dispatch<React.SetStateAction<number>>;
}

interface Prices {
  returnPrice: number;
  exchangePrice: number;
  totalPrice: number;
}
// Helper functions
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

// Components
const OrderWindowContent = ({
  position,
  name,
  items,
  order,
  setPosition,
  setCredito,
  totalPrice,
  credito,
}: {
  position: number;
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean>>;
  totalPrice: number;
  credito: boolean;
}) => {
  const windows = {
    1: <FirstWindow name={name} items={items} />,
    2: (
      <SecondWindow
        order={order}
        position={position}
        setPosition={setPosition}
        items={items}
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
        />
      ) : null,
    4: (
      <LastWindow
        items={items}
        position={position}
        setPosition={setPosition}
        credito={credito}
      />
    ),
  };
  const itemsToShow = items.filter((item) => item.action && !item.confirmed);

  if (itemsToShow.length === 0) {
    setPosition(1);
  }

  return windows[position as keyof typeof windows] || null;
};

export const OrderWindow = ({
  position,
  ...props
}: {
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean>>;
  credito: boolean;
} & Omit<ClientOrderProps, "setPosition">) => {
  const { totalPrice } = calculatePrices(props.items);

  return (
    <OrderWindowContent
      position={position}
      name={props.name}
      items={props.items}
      order={props.order}
      setPosition={props.setPosition}
      setCredito={props.setCredito}
      totalPrice={totalPrice}
      credito={props.credito}
    />
  );
};
