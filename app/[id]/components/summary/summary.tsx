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
import { valueBasket } from "@/lib/basket";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";

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
  const t = useT();
  const locale = useLocale();
  const { basket, itemsToDevolver, itemsToCambio, itemsToDev } = useMemo(() => {
    // The money comes from the one shared valuation (lib/basket.ts) — the same
    // one payments.ts charges from — so the figures below cannot drift from
    // the amount Stripe bills.
    const basket = valueBasket(items, allProducts);

    // valueBasket returns totals, not the underlying rows. The accordion
    // bodies render the rows, so those filters stay local. They are the same
    // predicates valueBasket applies internally.
    const itemsToDevolver = items.filter(
      (item) => Boolean(item.action) && !item.confirmed
    );

    const itemsToCambio = items.filter(
      (item) => item.action === "CAMBIO" && !item.confirmed
    );

    const itemsToDev = items.filter(
      (item) => item.action === "DEVOLUCIÓN" && !item.confirmed
    );

    return { basket, itemsToDevolver, itemsToCambio, itemsToDev };
  }, [items, allProducts]);

  const totalPriceDevolver = basket.returnPrice;
  const totalPriceCambio = basket.exchangePrice;

  const fees = useFees();
  const { feeCents } = resolveFee(fees, basket);
  const shippingCost = centsToEuros(feeCents);

  const totalPrice = basket.netAmount - shippingCost;

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
      <h3 className="text-sm tracking-wider">{t.summary.heading}</h3>

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
                {t.summary.toReturn} <br />
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {formatEuros(totalPriceDevolver, locale)}
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
                {t.summary.newProducts}{" "}
                {shipping && itemsToDev.length > 0 && t.summary.andLogistics}
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {(totalPriceCambio > 0 || shipping) && "-"}
                {formatEuros(
                  shipping &&
                    (itemsToDev.length > 0 || itemsToCambio.length > 0)
                    ? totalPriceCambio + shippingCost
                    : totalPriceCambio,
                  locale
                )}
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
          <span className="font-semibold text-sm">{t.summary.bonus}</span>
          <span className="font-semibold text-sm">
            {formatEuros(creditBonus, locale)}
          </span>
        </div>
      )}

      {/* Total row */}
      <div className="bg-gray-300 flex flex-row justify-between items-center px-1 py-2 my-3 sm:px-2 sm:py-3 sm:my-4 rounded-sm">
        <span className="font-semibold">
          {finalTotal > 0 ? t.summary.totalRefund : t.summary.totalToPay}
        </span>
        <span className="font-semibold">
          {formatEuros(Math.abs(finalTotal), locale)}
        </span>
      </div>

      {!final && (
        <span className="text-xs font-light">{t.summary.provisional}</span>
      )}
      <span className="border w-full border-gray-300 my-3" />
    </div>
  );
};
