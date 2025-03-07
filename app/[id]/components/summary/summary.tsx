"use client";

import { useMemo } from "react";
import { productsOrder } from "@/db/schema";
import { SummaryLine } from "./summaryLine";
import { SummaryShipping } from "./summaryShipping";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";

type Props = {
  items: (typeof productsOrder.$inferSelect)[];
  shipping: boolean;
  final: boolean;
  credito?: boolean;
};

export const SummaryComponent = ({
  items,
  shipping,
  final,
  credito,
}: Props) => {
  const {
    totalPriceDevolver,
    itemsToDevolver,
    totalPriceCambio,
    itemsToCambio,
  } = useMemo(() => {
    const totalPriceDevolver = items
      .filter((item) => Boolean(item.action) && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const itemsToDevolver = items.filter(
      (item) => Boolean(item.action) && !item.confirmed
    );

    const totalPriceCambio = items
      .filter((item) => item.action === "CAMBIO" && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const itemsToCambio = items.filter(
      (item) => item.action === "CAMBIO" && !item.confirmed
    );

    return {
      totalPriceDevolver,
      itemsToDevolver,
      totalPriceCambio,
      itemsToCambio,
    };
  }, [items]);

  let totalPrice = totalPriceDevolver - totalPriceCambio;
  const shippingCost = Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);

  if (shipping && totalPrice !== 0) {
    totalPrice -= shippingCost;
  }

  const creditBonus = credito ? totalPrice * 0.15 : 0;
  const finalTotal = credito ? totalPrice * 1.15 : totalPrice;

  return (
    // Reduced top margin & padding on mobile, larger on desktop
    <div className="w-full h-full flex flex-col mt-2 p-1 sm:mt-5 sm:p-2">
      <h3 className="text-sm tracking-wider">DESGLOSE DE TU SOLICITUD</h3>

      <Accordion type="multiple" className="w-full mt-2 sm:mt-4 space-y-3">
        {/* Productos a devolver */}
        <AccordionItem
          value="productos_devolver"
          className="border-b rounded-lg"
        >
          <AccordionTrigger className="w-full px-2 py-1 sm:py-2">
            <div className="flex flex-row w-full justify-between items-center">
              {/* Left side (multiline text, left-aligned) */}
              <span className="font-medium text-left w-full">
                Productos a devolver <br />
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {totalPriceDevolver.toFixed(2)} €
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="mt-1 sm:mt-2">
            {itemsToDevolver.map((item) => (
              <SummaryLine key={item.id} item={item} newAction={false} />
            ))}
          </AccordionContent>
        </AccordionItem>

        {/* Nuevos productos & Logística */}
        <AccordionItem value="productos_cambio" className="border-b">
          <AccordionTrigger className="w-full px-2 py-1 sm:py-2">
            <div className="flex flex-row w-full justify-between items-center">
              {/* Left side (multiline text, left-aligned) */}
              <span className="font-medium text-left w-full">
                Nuevos productos {shipping && totalPrice !== 0 && "& Logística"}
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {(totalPriceCambio > 0 || shipping) && "-"}
                {shipping && totalPrice !== 0
                  ? (totalPriceCambio + shippingCost).toFixed(2)
                  : totalPriceCambio.toFixed(2)}
                {" €"}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="mt-1 sm:mt-2">
            {itemsToCambio.map((item) => (
              <SummaryLine key={item.id} item={item} newAction={true} />
            ))}
            {shipping && totalPrice !== 0 && <SummaryShipping />}
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* Crédito en tienda */}
      {credito && (
        <div className="w-full flex flex-row justify-between items-center mt-3 sm:mt-4">
          <span className="font-semibold text-sm">
            Bonificaciones - Crédito en tienda
          </span>
          <span className="font-semibold text-sm">
            {creditBonus.toFixed(2)} €
          </span>
        </div>
      )}

      {/* Total row */}
      <div className="bg-gray-300 flex flex-row justify-between items-center px-1 py-2 my-3 sm:px-2 sm:py-3 sm:my-4 rounded-sm">
        <span className="font-semibold">Total reembolso</span>
        <span className="font-semibold">{finalTotal.toFixed(2)} €</span>
      </div>

      {!final && (
        <span className="text-xs font-light">
          Resumen provisional. Puede cambiar a lo largo del proceso
        </span>
      )}
      <span className="border w-full border-gray-300 my-3" />
    </div>
  );
};
