"use client";
import Image from "next/image";
import Logo from "@/public/LOGO_black.png";
import { orders, productsOrder } from "@/db/schema";
import { useState } from "react";
import { Product } from "@/types";
import { FirstWindow } from "./components/firstWindow";
import { SecondWindow } from "./components/secondWindow";
import { cn } from "@/lib/utils";
import { ThirdWindow } from "./components/thirdWindow";
import { LastWindow } from "./components/lastWindow";
import { AsyncButton } from "@/components/asyncButton";

type Props = {
  name: string;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  order: typeof orders.$inferSelect;
  id: string;
};
export const ClientOrder = ({ name, items, order, id }: Props) => {
  const [position, setPosition] = useState<number>(1);
  const handleClick = () => {
    setPosition(position + 1);
  };
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black-pattern gap-10 pb-20">
      <div className="bg-white flex flex-col w-[30%] rounded-b-3xl items-center py-3 px-5">
        <Image src={Logo} alt="Logo" width={150} height={150} />
        <span className="border w-full border-slate-200 mt-2" />
        <h3 className="text-xs mt-2 text-slate-500">CAMBIOS Y DEVOLUCIONES</h3>
      </div>
      <div className="bg-white-pattern flex flex-col w-[30%] rounded-3xl items-center py-10 px-6">
        {position === 1 && <FirstWindow name={name} items={items} />}
        {position === 2 && (
          <SecondWindow
            order={order}
            position={position}
            setPosition={setPosition}
            items={items}
          />
        )}
        {position === 3 && <ThirdWindow items={items} shipping={true} />}
        {position === 4 && <LastWindow items={items} shipping={true} />}
        {position >= 4 && <AsyncButton text="Actualizar pedido" id={id} />}
        {position < 4 && (
          <button
            className={cn(
              "bg-slate-300 py-4 rounded-full hover:bg-blue-400 focus:bg-blue-400 flex items-center justify-center w-full",
              position === 2 && "hidden"
            )}
            onClick={handleClick}
          >
            Continuar
          </button>
        )}
      </div>
    </div>
  );
};
