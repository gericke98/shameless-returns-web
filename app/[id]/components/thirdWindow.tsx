import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { cn } from "@/lib/utils";
import RegaloWhite from "@/public/giftWhite.svg";
import RegaloBlack from "@/public/giftBlack.svg";
import CardWhite from "@/public/cardWhite.svg";
import CardBlack from "@/public/cardBlack.svg";
import { Product } from "@/types";
import Image from "next/image";
import { useState } from "react";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  shipping: boolean;
};

export const ThirdWindow = ({ items, shipping }: Props) => {
  const totalPriceDevolver = items
    .filter((item) => item.action)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const itemsToDevolver = items.filter((item) => item.action);

  const totalPriceCambio = items
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const itemsToCambio = items.filter((item) => item.action === "CAMBIO");
  let totalPrice = totalPriceDevolver - totalPriceCambio;
  if (shipping) {
    totalPrice = totalPrice - Number(4.01);
  }
  const [selected, setSelected] = useState<number>(0);
  return (
    <div className="w-full h-full flex flex-col gap-3 mb-3">
      <Progress value={75} />
      <h3 className="font-bold text-2xl text-left mt-4">Elige tu reembolso</h3>
      <div
        className={cn(
          "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer",
          selected === 0 ? "bg-black" : "bg-white"
        )}
        onClick={() => setSelected(0)}
      >
        <div className="w-full flex flex-row gap-2">
          <Image
            src={selected === 0 ? RegaloWhite : RegaloBlack}
            alt="Icon regalo"
            width={50}
            height={30}
            className={cn(
              "rounded-full p-2 my-1",
              selected === 0 ? "bg-teal-700" : "bg-teal-200 "
            )}
          />
          <div className="w-full flex flex-col items-start">
            <h3
              className={cn(
                " font-bold text-lg",
                selected === 0 ? "text-white" : "text-black "
              )}
            >
              Crédito en tienda
            </h3>
            <p className="bg-cyan-400 text-xs w-24 p-1 rounded-full font-bold text-center text-black">
              +15% extra
            </p>
          </div>
        </div>
        <p
          className={cn(
            "text-sm",
            selected === 0 ? "text-white" : "text-black "
          )}
        >
          Recibe,{" "}
          <span className="font-bold">cuando se acepte tu devolución</span>, un
          cheque regalo para volver a comprar en la tienda online de Shameless
          Collective, con hasta un +15% extra de regalo sobre tu devolución.
        </p>
        <span
          className={cn(
            "border-b w-full mt-1",
            selected === 0 ? "border-white" : "border-black "
          )}
        />
        <p
          className={cn(
            "text-sm",
            selected === 0 ? "text-white" : "text-black "
          )}
        >
          Reembolso total: {(totalPrice * 1.15).toFixed(2)} €
        </p>
      </div>
      <div
        className={cn(
          "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer",
          selected === 1 ? "bg-black" : "bg-white"
        )}
        onClick={() => setSelected(1)}
      >
        <div className="w-full flex flex-row gap-2">
          <Image
            src={selected === 1 ? CardWhite : CardBlack}
            alt="Icon regalo"
            width={50}
            height={30}
            className={cn(
              "rounded-full p-2 my-1",
              selected === 1 ? "bg-teal-700" : "bg-teal-200 "
            )}
          />
          <div className="w-full flex flex-col items-start justify-center">
            <h3
              className={cn(
                " font-bold text-lg",
                selected === 1 ? "text-white" : "text-black "
              )}
            >
              Método de pago original
            </h3>
          </div>
        </div>
        <p
          className={cn(
            "text-sm",
            selected === 1 ? "text-white" : "text-black "
          )}
        >
          Recibe tu dinero,{" "}
          <span className="font-bold">cuando se acepte tu devolución</span>, en
          el método de pago que usaste en tu compra. Puede demorar hasta 15
          días.
        </p>
        <span
          className={cn(
            "border-b w-full mt-1",
            selected === 1 ? "border-white" : "border-black "
          )}
        />
        <p
          className={cn(
            "text-sm",
            selected === 1 ? "text-white" : "text-black "
          )}
        >
          Reembolso total: {totalPrice.toFixed(2)} €
        </p>
      </div>
    </div>
  );
};
