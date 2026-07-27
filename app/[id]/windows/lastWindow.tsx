import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  credito: boolean | null;
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  id: string;
  allProducts: Product[];
};

const LastWindowBase = ({
  items,
  position,
  setPosition,
  credito,
  onItemChange,
  id,
  allProducts,
}: Props) => {
  const fees = useFees();
  const t = useT();
  const locale = useLocale();
  const { totalPriceDevolver, totalPriceCambio, totalPrice, finalTotal } =
    useMemo(() => {
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

      let totalPrice = totalPriceDevolver - totalPriceCambio;

      // Rule A, shared with every other site and with the server-side charge.
      // This previously used a Rule B variant keyed on action type, which
      // disagreed with the checkout total on a cheaper-item exchange.
      const { feeCents } = resolveFee(fees, {
        hasItems: items.some((item) => item.action && !item.confirmed),
        netAmount: totalPrice,
      });

      totalPrice -= centsToEuros(feeCents);

      // Calculate finalTotal the same way as SummaryComponent
      const finalTotal = credito ? totalPrice * 1.15 : totalPrice;

      return { totalPriceDevolver, totalPriceCambio, totalPrice, finalTotal };
    }, [allProducts, credito, items, fees]);

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
            credito={credito || false}
            allProducts={allProducts}
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
