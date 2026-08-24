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
import type { ReturnMethod } from "@/lib/returnMethods";

type Props = {
  items: (typeof productsOrder.$inferSelect)[];
  shipping: boolean;
  final: boolean;
  credito?: boolean;
  allProducts?: Product[];
  /**
   * The lane the customer has chosen, where a choice has been offered. This box
   * and the refund paragraph below it are rendered two lines apart on the same
   * screen, so a component that cannot see the choice states a total that
   * disagrees with the one beside it by exactly the return leg — and itemises a
   * return-shipping charge the customer is not paying. Optional: the earlier
   * windows render before the choice exists, and undefined behaves exactly as
   * before self-booking.
   */
  method?: ReturnMethod;
};

export const SummaryComponent = ({
  items,
  shipping,
  final,
  credito,
  allProducts = [],
  method,
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
  const { feeCents, returnLegCents, outboundLegCents } = resolveFee(
    fees,
    basket
  );
  // Mirror actions/payments.ts exactly: a self-booked return pays the outbound
  // leg only, never the return leg. The customer is paying their own courier
  // for that journey.
  const selfBooked = method === "SELF";
  const chargeCents = selfBooked ? outboundLegCents : feeCents;
  const shippingCost = centsToEuros(chargeCents);
  // Split for display only. The charge is chargeCents; these two add up to it.
  const returnLegCost = centsToEuros(selfBooked ? 0 : returnLegCents);
  const outboundLegCost = centsToEuros(outboundLegCents);

  const totalPrice = basket.netAmount - shippingCost;

  // The second section holds replacement items and the shipping fee, and its
  // heading has to describe whichever of those it actually contains. A pure
  // return has no replacements, so calling it "New items & Shipping" named a
  // row that was not there.
  //
  // One value drives the heading, the amount and the shipping line, because
  // they previously disagreed: the heading appended "& Shipping" only when
  // there were DEVOLUCIÓN items, while the amount added the fee whenever
  // anything was selected. An exchange-only basket was charged shipping under
  // a heading that did not mention it.
  const hasNewItems = itemsToCambio.length > 0;
  // `chargeCents > 0` because a self-booked pure return is charged nothing at
  // all: heading the section "& Shipping" and itemising "- 0.00" bills the
  // customer, on screen, for a leg they arranged and paid for themselves.
  const showsShipping =
    shipping && itemsToDevolver.length > 0 && chargeCents > 0;

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

      <Accordion type="multiple" className="w-full mt-2 sm:mt-4 space-y-1">
        {/* Productos a devolver */}
        <AccordionItem
          value="productos_devolver"
          className="border-b rounded-lg"
        >
          <AccordionTrigger className="w-full px-2 py-1">
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
          <AccordionTrigger className="w-full px-2 py-1">
            <div className="flex flex-row w-full justify-between items-center">
              {/* Left side (multiline text, left-aligned) */}
              <span className="font-medium text-left w-full">
                {hasNewItems
                  ? `${t.summary.newProducts}${
                      showsShipping ? ` ${t.summary.andLogistics}` : ""
                    }`
                  : t.summary.shipping}
                <span className="font-normal text-xs text-gray-600"></span>
              </span>

              {/* Right side (total, right-aligned) */}
              <span className="font-semibold text-sm text-right mt-1 sm:mt-0 w-full">
                {(totalPriceCambio > 0 || showsShipping) && "-"}
                {formatEuros(
                  showsShipping
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
            {showsShipping && (
                <SummaryShipping
                  returnCost={returnLegCost}
                  outboundCost={outboundLegCost}
                />
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
      {/* White rather than grey. It needs the border to still read as a box:
          the card behind it is the off-white paper texture, not pure white. */}
      <div className="bg-white border border-gray-200 flex flex-row justify-between items-center px-1 py-2 my-3 sm:px-2 sm:py-3 sm:my-4 rounded-sm">
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
