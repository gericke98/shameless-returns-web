import { productsOrder } from "@/db/schema";
import { SummaryLine } from "./summaryLine";
import { SummaryShipping } from "./summaryShipping";

type Props = {
  items: (typeof productsOrder.$inferSelect)[];
  shipping: boolean;
  final: boolean;
  credito?: boolean;
};

const calculateTotalPrice = (
  items: (typeof productsOrder.$inferSelect)[],
  filter: (item: typeof productsOrder.$inferSelect) => boolean
) => {
  return items
    .filter(filter)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
};

const filterItems = (
  items: (typeof productsOrder.$inferSelect)[],
  filter: (item: typeof productsOrder.$inferSelect) => boolean
) => {
  return items.filter(filter);
};

export const SummaryComponent = ({
  items,
  shipping,
  final,
  credito,
}: Props) => {
  const totalPriceDevolver = calculateTotalPrice(
    items,
    (item) => Boolean(item.action) && !item.confirmed
  );
  const itemsToDevolver = filterItems(
    items,
    (item) => Boolean(item.action) && !item.confirmed
  );

  const totalPriceCambio = calculateTotalPrice(
    items,
    (item) => item.action === "CAMBIO" && !item.confirmed
  );
  const itemsToCambio = filterItems(
    items,
    (item) => item.action === "CAMBIO" && !item.confirmed
  );

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
        <div className="w-full h-full flex flex-row justify-between">
          <h5 className="font-semibold text-sm">Productos a devolver</h5>
          <h5 className="font-semibold text-sm">
            {totalPriceDevolver.toFixed(2)} €
          </h5>
        </div>

        {itemsToDevolver.map((item) => (
          <SummaryLine key={item.id} item={item} newAction={false} />
        ))}

        <div className="w-full h-full flex flex-row justify-between mt-5">
          <h5 className="font-semibold text-sm">
            Nuevos productos {shipping && totalPrice !== 0 && "& Logística"}
          </h5>
          <h5 className="font-semibold text-sm">
            {(totalPriceCambio > 0 || shipping) && "-"}
            {shipping && totalPrice !== 0
              ? (totalPriceCambio + shippingCost).toFixed(2)
              : totalPriceCambio.toFixed(2)}
            {" €"}
          </h5>
        </div>

        {itemsToCambio.map((item) => (
          <SummaryLine key={item.id} item={item} newAction={true} />
        ))}

        {shipping && totalPrice !== 0 && <SummaryShipping />}

        {credito && (
          <div className="w-full h-full flex flex-row justify-between mt-5">
            <h5 className="font-semibold text-sm">
              Bonificaciones - Crédito en tienda
            </h5>
            <h5 className="font-semibold text-sm">
              {creditBonus.toFixed(2)} €
            </h5>
          </div>
        )}
      </div>

      <div className="bg-gray-300 flex flex-row justify-between px-2 py-3 my-4 rounded-sm mt-4">
        <h6 className="pl-5 font-semibold">Total reembolso</h6>
        <h6 className="pr-1 font-semibold">{finalTotal.toFixed(2)} €</h6>
      </div>

      {!final && (
        <h5 className="text-xs mt-0 mb-4 font-light">
          Resumen provisional. Puede cambiar a lo largo del proceso
        </h5>
      )}

      <span className="border w-full border-gray-300 my-3" />
    </div>
  );
};
