"use client";
import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
import { orders, productsOrder } from "@/db/schema";
import { useState } from "react";
import { Product } from "@/types";
import { FirstWindow } from "./components/firstWindow";
import { SecondWindow } from "./components/secondWindow";
import { ThirdWindow } from "./components/thirdWindow";
import { LastWindow } from "./components/lastWindow";
import { AsyncButton } from "@/components/asyncButton";
import { cn } from "@/lib/utils";

type OrderItem = typeof productsOrder.$inferSelect & { newp?: Product };
type OrderData = typeof orders.$inferSelect;

interface ClientOrderProps {
  name: string;
  items: OrderItem[];
  order: OrderData;
  id: string;
  setPosition?: React.Dispatch<React.SetStateAction<number>>;
}

const calculatePrices = (items: OrderItem[]) => {
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

const OrderWindow = ({
  position,
  ...props
}: {
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
} & Omit<ClientOrderProps, "setPosition">) => {
  const [credito, setCredito] = useState<boolean | null>(null);
  const { totalPrice } = calculatePrices(props.items);

  switch (position) {
    case 1:
      return <FirstWindow name={props.name} items={props.items} />;
    case 2:
      return (
        <SecondWindow
          order={props.order}
          position={position}
          setPosition={props.setPosition}
          items={props.items}
        />
      );
    case 3:
      return totalPrice !== 0 ? (
        <ThirdWindow
          items={props.items}
          shipping={true}
          position={position}
          setPosition={props.setPosition}
          setCredito={setCredito}
        />
      ) : null;
    case 4:
      return (
        <LastWindow
          items={props.items}
          position={position}
          setPosition={props.setPosition}
          credito={credito}
        />
      );
    default:
      return null;
  }
};

export const ClientOrder = ({ name, items, order, id }: ClientOrderProps) => {
  const [position, setPosition] = useState<number>(1);
  const hasChanges = items.some((item) => item.action);

  return (
    <div className="flex min-h-screen flex-col items-center justify-between bg-black-pattern gap-10 pb-20">
      <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-b-3xl items-center py-3 px-4 lg:px-6">
        <Image src={Logo} alt="Logo" width={150} height={150} />
        <span className="border w-full border-slate-200 mt-2" />
        <h3 className="text-xs mt-2 text-slate-500">CAMBIOS Y DEVOLUCIONES</h3>
      </div>

      <div className="bg-white-pattern flex flex-col lg:w-[30%] w-[85%] rounded-3xl items-center py-10 px-4 lg:px-6">
        <OrderWindow
          position={position}
          name={name}
          items={items}
          order={order}
          id={id}
          setPosition={setPosition}
        />

        {position >= 4 ? (
          <AsyncButton text="Actualizar pedido" id={id} />
        ) : (
          <button
            className={cn(
              "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold",
              position === 2 && "hidden",
              !hasChanges && "hidden"
            )}
            onClick={() => setPosition(position + 1)}
            disabled={!hasChanges}
          >
            Continuar
          </button>
        )}
      </div>
    </div>
  );
};
