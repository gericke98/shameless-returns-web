"use client";

import { memo, useEffect, useMemo, useState } from "react";
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
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros, type Dictionary, type Locale } from "@/lib/i18n";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  shipping: boolean;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  setCredito: React.Dispatch<React.SetStateAction<boolean>>;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
  credito: boolean;
  allProducts: Product[];
};

// Reusable sub-component for Store Credit.
// `t` and `locale` arrive as props: this is declared at module scope, outside
// the component that reads the locale context, so it cannot call the hooks.
const StoreCredit = ({
  totalPrice,
  isSelected,
  onClick,
  t,
  locale,
}: {
  totalPrice: number;
  isSelected: boolean;
  onClick: () => void;
  t: Dictionary;
  locale: Locale;
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
          {t.third.storeCredit}
        </h3>
        <p className="bg-cyan-400 text-xs w-24 p-1 rounded-full font-bold text-center text-black">
          {t.third.storeCreditBadge}
        </p>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      {t.third.storeCreditBody}
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
      {t.third.totalRefund}: {formatEuros(totalPrice * 1.15, locale)}
    </p>
  </div>
);

// Reusable sub-component for Original Payment.
// Same module-scope constraint as StoreCredit: `t` and `locale` are props.
const OriginalPayment = ({
  totalPrice,
  isSelected,
  onClick,
  t,
  locale,
}: {
  totalPrice: number;
  isSelected: boolean;
  onClick: () => void;
  t: Dictionary;
  locale: Locale;
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
          {t.third.originalPayment}
        </h3>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      {t.third.originalPaymentBody}
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
      {t.third.totalRefund}: {formatEuros(totalPrice, locale)}
    </p>
  </div>
);

const ThirdWindowBase = ({
  items,
  shipping,
  position,
  setPosition,
  setCredito,
  credito,
  allProducts,
}: Props) => {
  const [selected, setSelected] = useState<number>(0);
  const fees = useFees();
  const t = useT();
  const locale = useLocale();

  // Compute the total price after subtracting the "CAMBIO" items and shipping
  const totalPrice = useMemo(() => {
    const totalPriceDevolver = items
      .filter((item) => item.action && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const totalPriceCambio = items
      .filter((item) => item.action === "CAMBIO" && !item.confirmed)
      .reduce((sum, item) => {
        // If there's a new variant ID, find the corresponding product and use its price
        if (item.new_variant_id) {
          const newProduct = allProducts.find((p) =>
            p.variants.edges.some((v) => v.node.id === item.new_variant_id)
          );
          if (newProduct) {
            // Find the specific variant that matches the new_variant_id
            const newVariant = newProduct.variants.edges.find(
              (v) => v.node.id === item.new_variant_id
            );
            if (newVariant) {
              return sum + parseFloat(newVariant.node.price);
            }
          }
        }
        // Fallback to the original price if no new product is found
        return sum + parseFloat(item.price);
      }, 0);

    let result = totalPriceDevolver - totalPriceCambio;
    const { feeCents } = resolveFee(fees, {
      hasItems: items.some((item) => item.action && !item.confirmed),
      netAmount: result,
    });

    if (shipping) {
      result -= centsToEuros(feeCents);
    }
    return result;
  }, [allProducts, items, shipping, fees]);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

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
        {t.third.title}
      </h3>

      {/* Two reembolso options side by side on large screens, stacked on mobile */}
      <div className="flex flex-col gap-3 w-full">
        <StoreCredit
          totalPrice={totalPrice}
          isSelected={credito}
          onClick={() => {
            setSelected(0);
            setCredito(true);
          }}
          t={t}
          locale={locale}
        />
        <OriginalPayment
          totalPrice={totalPrice}
          isSelected={!credito}
          onClick={() => {
            setSelected(1);
            setCredito(false);
          }}
          t={t}
          locale={locale}
        />
      </div>
    </div>
  );
};

export const ThirdWindow = memo(ThirdWindowBase);
