"use client";

import { memo, useMemo, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import Image from "next/image";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { cn } from "@/lib/utils";
import RegaloWhite from "@/public/giftWhite.svg";
import RegaloBlack from "@/public/giftBlack.svg";
import CardWhite from "@/public/cardWhite.svg";
import CardBlack from "@/public/cardBlack.svg";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  shipping: boolean;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean>>;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
};

// Reusable sub-component for Store Credit
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
      "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer transition-colors",
      isSelected ? "bg-black" : "bg-white border border-gray-300"
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

// Reusable sub-component for Original Payment
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
      "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer transition-colors",
      isSelected ? "bg-black" : "bg-white border border-gray-300"
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

const ThirdWindowBase = ({
  items,
  shipping,
  position,
  setPosition,
  setCredito,
}: Props) => {
  const [selected, setSelected] = useState<number>(0);

  // Compute the total price after subtracting the "CAMBIO" items and shipping
  const totalPrice = useMemo(() => {
    const totalPriceDevolver = items
      .filter((item) => item.action && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const totalPriceCambio = items
      .filter((item) => item.action === "CAMBIO" && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    let result = totalPriceDevolver - totalPriceCambio;

    if (shipping && result !== 0) {
      result -= Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);
    }
    return result;
  }, [items, shipping]);

  return (
    // Use a container with max-w to keep things narrow on large screens,
    // but fill the screen on mobile.
    <div className="w-full mx-auto flex flex-col p-2 sm:p-4 mb-3">
      {/* Progress Bar */}
      <Progress value={75} className="mb-2" />

      {/* Back Arrow */}
      <FaArrowAltCircleLeft
        size={25}
        className="mt-2 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />

      {/* Title */}
      <h3 className="font-bold text-xl sm:text-2xl text-left mt-2 mb-4">
        Elige tu reembolso
      </h3>

      {/* Two reembolso options side by side on large screens, stacked on mobile */}
      <div className="flex flex-col gap-3 w-full">
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

export const ThirdWindow = memo(ThirdWindowBase);
