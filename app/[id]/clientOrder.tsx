"use client";

import { orders, productsOrder } from "@/db/schema";
import { useState } from "react";
import { OrderItem, Product2 } from "@/types";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { ContinueButton } from "./components/buttons/nextButton";
import { OrderWindow } from "./windows/orderWindow";
import { Header } from "./windows/header";

interface ClientOrderProps {
  name: string;
  items: OrderItem[];
  order: typeof orders.$inferSelect;
  id: string;
  setPosition?: React.Dispatch<React.SetStateAction<number>>;
}

export const ClientOrder = ({ name, items, order, id }: ClientOrderProps) => {
  const [position, setPosition] = useState<number>(1);
  const [credito, setCredito] = useState<boolean>(true);
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
          credito={credito}
          setCredito={setCredito}
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
