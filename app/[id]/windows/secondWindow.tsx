"use client";

import { memo, useEffect, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import Image from "next/image";
import Link from "next/link";
import { IoLocationSharp } from "react-icons/io5";
import CorreosLogo from "@/public/correos.webp";
import { SecondWindowForm } from "../components/secondWindowForm";
import { orders, productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";
import { isInternationalOrder } from "@/lib/countries";
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
  // RETURN METHOD. Only the return leg is the cost of the drop-off; the rest
  // is delivering the replacement, which happens whatever method is chosen.
  // Billing the combined figure against the method overstated it — an Italian
  // exchange read "Cost: 18.20 €" for a drop-off that costs 11.00 €.
  const { returnLegCents, outboundLegCents } = resolveFee(fees, basket);

  // Spain drops the parcel at a Correos point; everything else is collected
  // from the customer's address through Amphora. Read from the stored
  // country, which the address form renders read-only for exactly this kind
  // of reason — it decides the carrier and the flow, not just the wording.
  const isInternational = isInternationalOrder(order.shippingCountry);
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
        <h3 className="font-bold text-lg sm:text-xl text-left mt-2">
          {t.second.title}
        </h3>

        {/* Subtitle */}
        <p className="mt-3 text-xs sm:text-sm text-gray-700">
          {t.second.subtitle}
        </p>

        {/*
        On mobile, stack vertically.
        On larger screens, keep the "icon" and "info" side by side.
      */}
        <div className="w-full flex flex-col sm:flex-row rounded-lg my-5 border-2 border-shameless-orange hover:cursor-pointer">
          {/* Selected-method icon block — orange, matching the refund cards on
              the next screen. Was black. */}
          <div className="bg-shameless-orange flex flex-row sm:flex-col items-center justify-center p-2 sm:p-3">
            <IoLocationSharp size={30} color="white" />
          </div>

          {/* Info Container */}
          <div className="w-full flex flex-col p-2 sm:p-3">
            <div className="flex flex-row items-center gap-2">
              {/* Correos only brands the domestic method, because Correos only
                  carries the domestic method. An international return is
                  collected by whoever Amphora routes it to, so naming a
                  carrier there would be wrong. */}
              {!isInternational && (
                <Image
                  src={CorreosLogo}
                  alt="Logo correos"
                  width={35}
                  height={40}
                />
              )}
              <h5 className="text-xs sm:text-sm font-semibold">
                {isInternational ? t.second.pickup : t.second.dropoff}
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
            <h3 className="font-bold text-sm sm:text-base">
              {isInternational ? t.second.pickupTitle : t.second.dropoffTitle}
            </h3>
          </div>

          {/* The locator link belongs to the domestic flow only — it points at
              Correos offices, which are no use to someone in Italy whose
              parcel is being collected from their door. */}
          <p className="mt-2 text-xs sm:text-sm font-light">
            {isInternational ? t.second.pickupBody : t.second.dropoffBody}
            {!isInternational && (
              <>
                {" "}
                <Link
                  href="https://www.correos.es/es/es/herramientas/oficinas-buzones-citypaq/detalle"
                  className="text-blue-500 font-semibold"
                >
                  {t.second.dropoffLink}
                </Link>
              </>
            )}
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
