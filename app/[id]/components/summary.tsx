import { productsOrder } from "@/db/schema";
import { SummaryLine } from "./summaryLine";
import { SummaryShipping } from "./summaryShipping";

type Props = {
  items: (typeof productsOrder.$inferSelect)[];
  shipping: boolean;
  final: boolean;
};
export const SummaryComponent = ({ items, shipping, final }: Props) => {
  const totalPriceDevolver = items
    .filter((item) => item.action)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const itemsToDevolver = items.filter((item) => item.action);

  const totalPriceCambio = items
    .filter((item) => item.action === "CAMBIO")
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const itemsToCambio = items.filter((item) => item.action === "CAMBIO");

  let totalPrice = totalPriceDevolver - totalPriceCambio;
  if (shipping) {
    totalPrice = totalPrice - Number(4);
  }
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
            Nuevos productos solicitados {shipping && "& Logística"}
          </h5>
          <h5 className="font-semibold text-sm">
            {"-"}
            {shipping
              ? (totalPriceCambio + Number(4)).toFixed(2)
              : totalPriceCambio.toFixed(2)}
            {" €"}
          </h5>
        </div>
        {itemsToCambio.map((item) => (
          <SummaryLine key={item.id} item={item} newAction={true} />
        ))}
        {shipping && <SummaryShipping />}
      </div>
      <div className="bg-gray-300 flex flex-row justify-between px-2 py-3 my-4 rounded-sm mt-4">
        <h6 className="pl-5 font-semibold">Total reembolso</h6>
        <h6 className="pr-1 font-semibold">{totalPrice.toFixed(2)} €</h6>
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
