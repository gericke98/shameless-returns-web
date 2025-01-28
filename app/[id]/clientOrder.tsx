"use client";
import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
import { orders, productsOrder } from "@/db/schema";
import { useState } from "react";
import { Product2 } from "@/types";
import { FirstWindow } from "./windows/firstWindow";
import { SecondWindow } from "./windows/secondWindow";
import { ThirdWindow } from "./windows/thirdWindow";
import { LastWindow } from "./windows/lastWindow";
import { AsyncButton } from "@/components/asyncButton";
import { cn } from "@/lib/utils";

// Types
type OrderItem = typeof productsOrder.$inferSelect & {
  newp?: Product2;
};

type OrderData = typeof orders.$inferSelect;

interface ClientOrderProps {
  name: string;
  items: OrderItem[];
  order: OrderData;
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
  order: OrderData;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean | null>>;
  totalPrice: number;
  credito: boolean | null;
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

  return windows[position as keyof typeof windows] || null;
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

  return (
    <OrderWindowContent
      position={position}
      name={props.name}
      items={props.items}
      order={props.order}
      setPosition={props.setPosition}
      setCredito={setCredito}
      totalPrice={totalPrice}
      credito={credito}
    />
  );
};

const Header = () => (
  <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-b-3xl items-center py-3 px-4 lg:px-6">
    <Image src={Logo} alt="Logo" width={150} height={150} />
    <span className="border w-full border-slate-200 mt-2" />
    <h3 className="text-xs mt-2 text-slate-500">CAMBIOS Y DEVOLUCIONES</h3>
  </div>
);

const ContinueButton = ({
  position,
  hasChanges,
  onClick,
}: {
  position: number;
  hasChanges: boolean;
  onClick: () => void;
}) => (
  <button
    className={cn(
      "bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold",
      position === 2 && "hidden",
      !hasChanges && "hidden"
    )}
    onClick={onClick}
    disabled={!hasChanges}
  >
    Continuar
  </button>
);

export const ClientOrder = ({ name, items, order, id }: ClientOrderProps) => {
  const [position, setPosition] = useState<number>(1);
  const [credito, setCredito] = useState<boolean | null>(null);
  const hasChanges = items.some((item) => item.action);

  return (
    <div className="flex min-h-screen flex-col items-center justify-between bg-black-pattern gap-10 pb-20">
      <Header />

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
          <AsyncButton
            text={credito ? "Solicitar crédito" : "Actualizar pedido"}
            id={id}
            isCredit={credito}
          />
        ) : (
          <ContinueButton
            position={position}
            hasChanges={hasChanges}
            onClick={() => setPosition(position + 1)}
          />
        )}
      </div>
    </div>
  );
};
