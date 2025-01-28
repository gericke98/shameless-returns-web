import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { cn } from "@/lib/utils";
import RegaloWhite from "@/public/giftWhite.svg";
import RegaloBlack from "@/public/giftBlack.svg";
import CardWhite from "@/public/cardWhite.svg";
import CardBlack from "@/public/cardBlack.svg";
import { Product2 } from "@/types";
import Image from "next/image";
import { useState } from "react";
import { FaArrowAltCircleLeft } from "react-icons/fa";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product2 })[];
  shipping: boolean;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean | null>>;
};

export const ThirdWindow = ({
  items,
  shipping,
  position,
  setPosition,
  setCredito,
}: Props) => {
  const [selected, setSelected] = useState<number>(0);

  const calculateTotalPrice = () => {
    const totalPriceDevolver = items
      .filter((item) => item.action && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const totalPriceCambio = items
      .filter((item) => item.action === "CAMBIO" && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    let totalPrice = totalPriceDevolver - totalPriceCambio;

    if (shipping && totalPrice !== 0) {
      totalPrice -= Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);
    }

    return totalPrice;
  };

  const totalPrice = calculateTotalPrice();

  const ReembolsoOption = ({
    isSelected,
    icon,
    iconAlt,
    title,
    bonusTag,
    description,
    total,
    onClick,
  }: {
    isSelected: boolean;
    icon: { white: any; black: any };
    iconAlt: string;
    title: string;
    bonusTag?: string;
    description: string;
    total: number;
    onClick: () => void;
  }) => (
    <div
      className={cn(
        "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer",
        isSelected ? "bg-black" : "bg-white"
      )}
      onClick={onClick}
    >
      <div className="w-full flex flex-row gap-2">
        <Image
          src={isSelected ? icon.white : icon.black}
          alt={iconAlt}
          width={50}
          height={30}
          className={cn(
            "rounded-full p-2 my-1",
            isSelected ? "bg-teal-700" : "bg-teal-200"
          )}
        />
        <div className="w-full flex flex-col items-start justify-center">
          <h3
            className={cn(
              "font-bold text-lg",
              isSelected ? "text-white" : "text-black"
            )}
          >
            {title}
          </h3>
          {bonusTag && (
            <p className="bg-cyan-400 text-xs w-24 p-1 rounded-full font-bold text-center text-black">
              {bonusTag}
            </p>
          )}
        </div>
      </div>
      <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
        {description}
      </p>
      <span
        className={cn(
          "border-b w-full mt-1",
          isSelected ? "border-white" : "border-black"
        )}
      />
      <p
        className={cn(
          "text-sm font-bold",
          isSelected ? "text-white" : "text-black"
        )}
      >
        Reembolso total: {total.toFixed(2)} €
      </p>
    </div>
  );

  return (
    <div className="w-full h-full flex flex-col mb-3">
      <Progress value={75} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />
      <h3 className="font-bold text-2xl text-left mt-1">Elige tu reembolso</h3>
      <div className="w-full h-full flex flex-col gap-3">
        <ReembolsoOption
          isSelected={selected === 0}
          icon={{ white: RegaloWhite, black: RegaloBlack }}
          iconAlt="Icon regalo"
          title="Crédito en tienda"
          bonusTag="+15% extra"
          description="Recibe, cuando se acepte tu devolución, un cheque regalo para volver a comprar en la tienda online de Shameless Collective, con hasta un +15% extra de regalo sobre tu devolución."
          total={totalPrice * 1.15}
          onClick={() => {
            setSelected(0);
            setCredito(true);
          }}
        />
        <ReembolsoOption
          isSelected={selected === 1}
          icon={{ white: CardWhite, black: CardBlack }}
          iconAlt="Icon tarjeta"
          title="Método de pago original"
          description="Recibe tu dinero, cuando se acepte tu devolución, en el método de pago que usaste en tu compra. Puede demorar hasta 15 días."
          total={totalPrice}
          onClick={() => {
            setSelected(1);
            setCredito(false);
          }}
        />
      </div>
    </div>
  );
};
