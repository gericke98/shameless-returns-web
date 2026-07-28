"use client";

import { memo, useEffect, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import Image from "next/image";
import { IoLocationSharp } from "react-icons/io5";
import Link from "next/link";
import { SecondWindowForm } from "../components/secondWindowForm";
import { orders, productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import CorreosLogo from "@/public/correos.webp";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";

type Props = {
  order: typeof orders.$inferSelect;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
  allProducts: Product[];
};

const SecondWindowBase = ({
  order,
  position,
  setPosition,
  items,
  onItemChange,
  id,
  allProducts,
}: Props) => {
  const t = useT();
  const locale = useLocale();
  // One shared valuation (lib/basket.ts), the same one payments.ts charges
  // from, so the "Cost" line below cannot drift from what Stripe bills.
  const basket = useMemo(
    () => valueBasket(items, allProducts),
    [allProducts, items]
  );
  const fees = useFees();
  // The legs are shown separately because this screen is about choosing a
  // RETURN METHOD. Only the return leg is the cost of dropping a parcel at a
  // Correos point; the rest is delivering the replacement, which happens
  // whatever method is chosen. Billing the combined figure against the method
  // overstated it — an Italian exchange read "Cost: 18.20 €" for a drop-off
  // that costs 11.00 €.
  const { returnLegCents, outboundLegCents } = resolveFee(fees, basket);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="w-full h-full flex flex-col p-2 sm:p-4">
      {/* Progress Bar */}
      <Progress value={50} className="mb-2" />

      {/* Back Arrow */}
      <FaArrowAltCircleLeft
        size={25}
        className="mt-2 cursor-pointer"
        onClick={() => setPosition(position - 1)}
      />
      <div className="space-y-8 p-0">
        {/* Title */}
        <h3 className="font-bold text-xl sm:text-2xl text-left mt-2">
          {t.second.title}
        </h3>

        {/* Subtitle */}
        <p className="mt-3 text-sm sm:text-base text-gray-700">
          {t.second.subtitle}
        </p>

        {/*
        On mobile, stack vertically.
        On larger screens, keep the "icon" and "info" side by side.
      */}
        <div className="w-full flex flex-col sm:flex-row rounded-lg my-5 border-2 border-black hover:cursor-pointer">
          {/* Black Icon Container */}
          <div className="bg-black flex flex-row sm:flex-col items-center justify-center p-2 sm:p-3">
            <IoLocationSharp size={30} color="white" />
          </div>

          {/* Info Container */}
          <div className="w-full flex flex-col p-2 sm:p-3">
            <div className="flex flex-row items-center gap-2">
              <Image
                src={CorreosLogo}
                alt="Logo correos"
                width={35}
                height={40}
                // Show the image on all screens, or hide on small if you want
                // className="hidden lg:block"
              />
              <h5 className="text-xs sm:text-sm font-semibold">
                {t.second.correosDropoff}
              </h5>
            </div>
            <div className="mt-1">
              <h5 className="text-xxs sm:text-xs">
                {t.second.cost}:{" "}
                {formatEuros(centsToEuros(returnLegCents), locale)}
              </h5>
              {outboundLegCents > 0 && (
                <h5 className="text-xxs sm:text-xs text-gray-600">
                  + {t.summary.deliveryShipping}:{" "}
                  {formatEuros(centsToEuros(outboundLegCents), locale)}
                </h5>
              )}
            </div>
          </div>
        </div>

        {/* Secondary Info Section */}
        <div className="w-full flex flex-col mt-2 p-0">
          {/* Title row */}
          <div className="flex flex-row items-center gap-2">
            <IoLocationSharp size={30} color="black" />
            <h3 className="font-bold text-base sm:text-lg">
              {t.second.dropoffTitle}
            </h3>
          </div>

          <p className="mt-2 text-sm sm:text-base font-light">
            {t.second.dropoffBody}{" "}
            <Link
              href="https://www.correos.es/es/es/herramientas/oficinas-buzones-citypaq/detalle"
              className="text-blue-500 font-semibold"
            >
              {t.second.dropoffLink}
            </Link>
          </p>

          {/* Form */}
          <SecondWindowForm
            order={order}
            position={position}
            setPosition={setPosition}
            items={items}
            onItemChange={onItemChange}
            allProducts={allProducts}
          />
        </div>
      </div>
    </div>
  );
};

export const SecondWindow = memo(SecondWindowBase);
