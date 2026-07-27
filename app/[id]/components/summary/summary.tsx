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
import { Product } from "@/types";
import { useFees } from "../../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";

type Props = {
  items: (typeof productsOrder.$inferSelect)[];
  shipping: boolean;
  final: boolean;
  credito?: boolean;
  allProducts?: Product[];
};

export const SummaryComponent = ({
  items,
  shipping,
  final,
  credito,
  allProducts = [],
}: Props) => {
  const {
    totalPriceDevolver,
    itemsToDevolver,
    totalPriceCambio,
    itemsToCambio,
    itemsToDev,
  } = useMemo(() => {
    const totalPriceDevolver = items
      .filter((item) => Boolean(item.action) && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);

    const itemsToDevolver = items.filter(
      (item) => Boolean(item.action) && !item.confirmed
    );

    // Calculate total price for changes, using the new product's price if available
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

    const itemsToCambio = items.filter(
      (item) => item.action === "CAMBIO" && !item.confirmed
    );

    const itemsToDev = items.filter(
      (item) => item.action === "DEVOLUCIÓN" && !item.confirmed
    );

    return {
      totalPriceDevolver,
      itemsToDevolver,
      totalPriceCambio,
      itemsToCambio,
      itemsToDev,
    };
  }, [items, allProducts]);

  let totalPrice = totalPriceDevolver - totalPriceCambio;
  const fees = useFees();
  const { feeCents } = resolveFee(fees, {
    hasItems: itemsToDevolver.length > 0,
    netAmount: totalPrice,
  });
  const shippingCost = centsToEuros(feeCents);

  totalPrice -= shippingCost;

  const creditBonus = credito ? totalPrice * 0.15 : 0;
  const finalTotal = credito ? totalPrice * 1.15 : totalPrice;

  // Helper function to find a product by variant ID
  const findProductByVariantId = (variantId: string | null) => {
    if (!variantId) return null;
    return (
      allProducts.find((p) =>
        p.variants.edges.some((v) => v.node.id === variantId)
      ) || null
    );
  };

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
              <SummaryLine
                key={item.id}
                item={item}
                newAction={false}
                newProduct={null}
              />
            ))}
          </AccordionContent>
        </AccordionItem>

        {/* Nuevos productos & Logística */}
        <AccordionItem value="productos_cambio" className="border-b">
          <AccordionTrigger className="w-full px-2 py-1 sm:py-2">
            <div className="flex flex-row w-full justify-between items-center">
              {/* Left side (multiline text, left-aligned) */}
              <span className="font-medium text-left w-full">
                Nuevos productos{" "}
                {shipping && itemsToDev.length > 0 && "& Logística"}
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {(totalPriceCambio > 0 || shipping) && "-"}
                {shipping && (itemsToDev.length > 0 || itemsToCambio.length > 0)
                  ? (totalPriceCambio + shippingCost).toFixed(2)
                  : totalPriceCambio.toFixed(2)}
                {" €"}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="mt-1 sm:mt-2">
            {itemsToCambio.map((item) => (
              <SummaryLine
                key={item.id}
                item={item}
                newAction={true}
                newProduct={findProductByVariantId(item.new_variant_id)}
              />
            ))}
            {shipping &&
              (itemsToDev.length > 0 || itemsToCambio.length > 0) && (
                <SummaryShipping shippingCost={shippingCost} />
              )}
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
        <span className="font-semibold">
          {finalTotal > 0 ? "Total reembolso" : "Total a pagar"}
        </span>
        <span className="font-semibold">
          {Math.abs(finalTotal).toFixed(2)} €
        </span>
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
