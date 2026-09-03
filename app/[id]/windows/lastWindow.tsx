import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee, sameZone } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";
import { ReturnMethodChoice } from "../components/returnMethodChoice";
import type { ReturnMethod } from "@/lib/returnMethods";
import {
  indexCatalogue,
  orderRatio,
  type PricedLine,
} from "@/lib/replacementPricing";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  credito: boolean | null;
  /**
   * The customer's claimed return lane. Lifted up to ClientOrder — the
   * lowest common ancestor of this component and AsyncButton — so the choice
   * made here actually reaches the submit button. See ReturnMethodChoice for
   * the gate that decides whether the control is shown at all.
   */
  method: ReturnMethod;
  setMethod: React.Dispatch<React.SetStateAction<ReturnMethod>>;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
  allProducts: Product[];
};

const LastWindowBase = ({
  items,
  position,
  setPosition,
  credito,
  method,
  setMethod,
  onItemChange,
  id,
  allProducts,
}: Props) => {
  const fees = useFees();
  const t = useT();
  const locale = useLocale();
  const { finalTotal, returnLegCents } = useMemo(() => {
    // One shared valuation (lib/basket.ts) — the same one payments.ts charges
    // from. Only the numbers are needed here; nothing on this screen renders a
    // filtered item list of its own.
    const basket = valueBasket(items, allProducts);

    // Rule A, shared with every other site and with the server-side charge.
    // This previously used a Rule B variant keyed on action type, which
    // disagreed with the checkout total on a cheaper-item exchange.
    const { feeCents, returnLegCents, outboundLegCents } = resolveFee(
      sameZone(fees),
      basket
    );

    // Mirror actions/payments.ts exactly: a self-booked return pays the
    // outbound leg only, never the return fee. Diverging here would show the
    // customer a total that disagrees with what Stripe actually charges.
    const chargeCents = method === "SELF" ? outboundLegCents : feeCents;

    const totalPrice = basket.netAmount - centsToEuros(chargeCents);

    // Calculate finalTotal the same way as SummaryComponent
    return {
      finalTotal: credito ? totalPrice * 1.15 : totalPrice,
      returnLegCents,
    };
  }, [allProducts, credito, items, fees, method]);

  // Same value SummaryComponent derives internally for its own cards, threaded
  // down to ProductLineClient so its "chosen replacement" card cannot show a
  // different median-basis price than the summary/Stripe total two lines
  // below it. See ProductLineProps.fallbackRatio.
  const fallbackRatio = useMemo(
    () =>
      orderRatio(
        items as unknown as PricedLine[],
        indexCatalogue(allProducts)
      ),
    [items, allProducts]
  );

  const handleBack = () => {
    setPosition(finalTotal > 0 ? position - 1 : position - 2);
  };

  return (
    <div className="w-full h-full flex flex-col mb-3">
      <Progress value={100} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={handleBack}
      />
      <h3 className="font-bold text-2xl text-left mt-1">{t.last.title}</h3>
      <div className="w-full h-full mt-5 rounded-xl hover:cursor-pointer flex flex-col gap-4">
        {items.map(
          (product) =>
            product.newp &&
            product.action &&
            !product.confirmed && (
              <ProductLineClient
                key={product.id}
                orderProduct={product}
                product={product.newp}
                onItemChange={onItemChange}
                allProducts={allProducts}
                fallbackRatio={fallbackRatio}
              />
            )
        )}
      </div>
      <span className="border-b border-slate-200 w-full" />
      <ReturnMethodChoice
        value={method}
        onChange={setMethod}
        returnLegCents={returnLegCents}
      />
      <div className="w-full mt-2 flex flex-col">
        {items.some((item) => item.action !== null) && (
          <SummaryComponent
            items={items}
            shipping={true}
            final={true}
            credito={credito || false}
            allProducts={allProducts}
            // Rendered two lines below the choice control. Without this the box
            // and the paragraph beneath it disagree by exactly the return leg.
            method={method}
          />
        )}
        {finalTotal < 0 ? (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">{t.last.exchangeTitle}</h3>
            <p className="text-black text-sm mt-2">
              <span className="font-bold">{t.last.exchangeBodyBold}</span>{" "}
              {t.last.exchangeBodyRest}{" "}
            </p>
          </div>
        ) : credito ? (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">{t.last.creditTitle}</h3>
            <p className="text-black text-sm">
              {t.last.creditBodyStart}{" "}
              <span className="font-bold">
                {formatEuros(finalTotal, locale)}{" "}
              </span>
              {t.last.creditBodyMid}{" "}
              <span className="font-bold">{t.last.creditBodyEnd}</span>
            </p>
          </div>
        ) : (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">{t.last.refundTitle}</h3>
            <p className="text-black text-sm">
              {t.last.refundBodyStart}{" "}
              <span className="font-bold">
                {formatEuros(finalTotal, locale)}{" "}
              </span>
              {t.last.refundBodyMid}{" "}
              <span className="font-bold">{t.last.refundBodyEnd}</span>
            </p>
            <p className="text-black text-sm mt-2">
              {t.last.refundDelayStart}{" "}
              <span className="font-bold">{t.last.refundDelayBold}</span>{" "}
              {t.last.refundDelayEnd}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export const LastWindow = memo(LastWindowBase);
