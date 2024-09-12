import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "./summary";
import { ProductLineClient } from "./productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";

type Props = {
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  credito: boolean | null;
};

export const LastWindow = ({
  items,
  position,
  setPosition,
  credito,
}: Props) => {
  const totalPriceDevolver = items
    .filter((item) => item.action && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);

  const totalPriceCambio = items
    .filter((item) => item.action === "CAMBIO" && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);

  let totalPrice = totalPriceDevolver - totalPriceCambio;
  if (totalPrice !== 0) {
    totalPrice = totalPrice - Number(4);
  }
  return (
    <div className="w-full h-full flex flex-col mb-3">
      <Progress value={100} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={() => {
          if (totalPrice !== 0) {
            setPosition(position - 1);
          } else {
            setPosition(position - 2);
          }
        }}
      />
      <h3 className="font-bold text-2xl text-left mt-1">Resumen final</h3>
      <div className="w-full h-full mt-5 rounded-xl hover:cursor-pointer flex flex-col gap-4">
        {items.map((product) => {
          if (product.newp && product.action) {
            return (
              <ProductLineClient
                key={product.id}
                orderProduct={product}
                product={product.newp.product}
              />
            );
          }
        })}
      </div>
      <span className="border-b border-slate-200 w-full" />
      <div className="w-full mt-2 flex flex-col">
        {items.some((item) => item.action !== null) && (
          <SummaryComponent
            items={items}
            shipping={true}
            final={true}
            credito={credito || false}
          />
        )}

        {totalPrice === 0 ? (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">Cambio de productos</h3>
            <p className="text-black text-sm mt-2">
              <span className="font-bold">
                Una vez devuelvas tus productos,
              </span>
              recibirás los nuevos que has seleccionado.
            </p>
          </div>
        ) : credito ? (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">Crédito en tienda</h3>
            <p className="text-black text-sm">
              Recibirás en tu correo un código por valor de{" "}
              <span className="font-bold">
                {(totalPrice * 1.15).toFixed(2)} €{" "}
              </span>
              con el que comprar de nuevo en Shameless Collective,{" "}
              <span className="font-bold">cuando se acepte tu devolución.</span>
            </p>
          </div>
        ) : (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">Reembolso tradicional</h3>
            <p className="text-black text-sm">
              Recibirás tu reembolso de{" "}
              <span className="font-bold">{totalPrice.toFixed(2)} € </span>
              en el método de pago que usaste en tu compra original,{" "}
              <span className="font-bold">cuando se acepte tu devolución.</span>
            </p>
            <p className="text-black text-sm mt-2">
              Debido al tiempo necesario para recibir los productos, revisarlos,
              y procesar la devolución,{" "}
              <span className="font-bold">pueden pasar hasta 15 días</span>{" "}
              hasta que recibas tu dinero.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
