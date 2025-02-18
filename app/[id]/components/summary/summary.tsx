import { useMemo } from "react";
import { productsOrder } from "@/db/schema";
import { SummaryLine } from "./summaryLine";
import { SummaryShipping } from "./summaryShipping";

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
    <div className="w-full h-full flex flex-col mt-5">
      <h3 className="text-sm tracking-wider">DESGLOSE DE TU SOLICITUD</h3>
      <div className="w-full h-full flex flex-col mt-4">
        <div className="w-full flex flex-row justify-between">
          <span className="font-semibold text-sm">Productos a devolver</span>
          <span className="font-semibold text-sm">
            {totalPriceDevolver.toFixed(2)} €
          </span>
        </div>
        {itemsToDevolver.map((item) => (
          <SummaryLine key={item.id} item={item} newAction={false} />
        ))}
        <div className="w-full flex flex-row justify-between mt-5">
          <span className="font-semibold text-sm">
            Nuevos productos {shipping && totalPrice !== 0 && "& Logística"}
          </span>
          <span className="font-semibold text-sm">
            {(totalPriceCambio > 0 || shipping) && "-"}
            {shipping && totalPrice !== 0
              ? (totalPriceCambio + shippingCost).toFixed(2)
              : totalPriceCambio.toFixed(2)}
            {" €"}
          </span>
        </div>
        {itemsToCambio.map((item) => (
          <SummaryLine key={item.id} item={item} newAction={true} />
        ))}
        {shipping && totalPrice !== 0 && <SummaryShipping />}
        {credito && (
          <div className="w-full flex flex-row justify-between mt-5">
            <span className="font-semibold text-sm">
              Bonificaciones - Crédito en tienda
            </span>
            <span className="font-semibold text-sm">
              {creditBonus.toFixed(2)} €
            </span>
          </div>
        )}
      </div>
      <div className="bg-gray-300 flex flex-row justify-between px-2 py-3 my-4 rounded-sm mt-4">
        <span className="pl-5 font-semibold">Total reembolso</span>
        <span className="pr-1 font-semibold">{finalTotal.toFixed(2)} €</span>
      </div>
      {!final && (
        <span className="text-xs mt-0 mb-4 font-light">
          Resumen provisional. Puede cambiar a lo largo del proceso
        </span>
      )}
      <span className="border w-full border-gray-300 my-3" />
    </div>
  );
};
