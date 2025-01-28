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

const StoreCredit = ({
  totalPrice,
  isSelected,
  onClick,
}: {
  totalPrice: number;
  isSelected: boolean;
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
        src={isSelected ? RegaloWhite : RegaloBlack}
        alt="Icon regalo"
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
          Crédito en tienda
        </h3>
        <p className="bg-cyan-400 text-xs w-24 p-1 rounded-full font-bold text-center text-black">
          +15% extra
        </p>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      Recibe, cuando se acepte tu devolución, un cheque regalo para volver a
      comprar en la tienda online de Shameless Collective, con hasta un +15%
      extra de regalo sobre tu devolución.
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
      Reembolso total: {(totalPrice * 1.15).toFixed(2)} €
    </p>
  </div>
);

const OriginalPayment = ({
  totalPrice,
  isSelected,
  onClick,
}: {
  totalPrice: number;
  isSelected: boolean;
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
        src={isSelected ? CardWhite : CardBlack}
        alt="Icon tarjeta"
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
          Método de pago original
        </h3>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      Recibe tu dinero, cuando se acepte tu devolución, en el método de pago que
      usaste en tu compra. Puede demorar hasta 15 días.
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
      Reembolso total: {totalPrice.toFixed(2)} €
    </p>
  </div>
);

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
        <StoreCredit
          totalPrice={totalPrice}
          isSelected={selected === 0}
          onClick={() => {
            setSelected(0);
            setCredito(true);
          }}
        />
        <OriginalPayment
          totalPrice={totalPrice}
          isSelected={selected === 1}
          onClick={() => {
            setSelected(1);
            setCredito(false);
          }}
        />
      </div>
    </div>
  );
};
