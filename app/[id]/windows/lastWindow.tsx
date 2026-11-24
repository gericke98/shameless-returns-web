import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import { shownTotalEuros } from "@/lib/agreement";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";
import { usePortalWizard } from "../wizardContext";
import {
  indexCatalogue,
  orderRatio,
  type PricedLine,
} from "@/lib/replacementPricing";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
  allProducts: Product[];
};

const LastWindowBase = ({ items, onItemChange, allProducts }: Props) => {
  const wizard = usePortalWizard();
  const t = useT();
  const locale = useLocale();
  // The wizard never renders this step while a required payout is missing
  // (currentStep in lib/portalWizard), so the agreement exists here. The
  // number on screen is the number the server agrees and Stripe takes.
  const agreement = wizard.terms.agreement;
  const finalTotal = agreement ? shownTotalEuros(agreement) : 0;

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

  return (
    <div className="w-full h-full flex flex-col mb-3">
      <Progress value={100} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={wizard.back}
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
      <div className="w-full mt-2 flex flex-col">
        {items.some((item) => item.action !== null) && (
          <SummaryComponent
            items={items}
            shipping={true}
            final={true}
            payout={wizard.payout}
            allProducts={allProducts}
            // The lane chosen on step 2. Without it the box and the paragraph
            // beneath it disagree by exactly the return leg.
            method={wizard.method}
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
        ) : !agreement || agreement.netCents <= 0 ? null : agreement.tender === "credit" ? (
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
