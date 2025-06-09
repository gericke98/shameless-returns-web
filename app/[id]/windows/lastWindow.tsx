import { memo, useMemo } from "react";
import { Progress } from "@/components/ui/progress";
import { productsOrder } from "@/db/schema";
import { Product } from "@/types";
import { SummaryComponent } from "../components/summary/summary";
import { ProductLineClient } from "../components/productLineClient";
import { FaArrowAltCircleLeft } from "react-icons/fa";

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
  const { totalPriceDevolver, totalPriceCambio, totalPrice, totalPrice2 } =
    useMemo(() => {
      const totalPriceDevolver = items
        .filter((item) => item.action && !item.confirmed)
        .reduce((sum, item) => sum + parseFloat(item.price), 0);
      const totalPriceCambio = items
        .filter((item) => item.action === "CAMBIO" && !item.confirmed)
        .reduce((sum, item) => sum + parseFloat(item.price), 0);
      const totalPriceCambio2 = items
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
      let totalPrice2 = totalPriceDevolver - totalPriceCambio2;
      if (totalPrice !== 0) {
        totalPrice -= Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST);
      }
      return { totalPriceDevolver, totalPriceCambio, totalPrice, totalPrice2 };
    }, [items]);

  const handleBack = () => {
    setPosition(totalPrice !== 0 ? position - 1 : position - 2);
  };

  return (
    <div className="w-full h-full flex flex-col mb-3">
      <Progress value={100} />
      <FaArrowAltCircleLeft
        size={25}
        className="mt-4 cursor-pointer"
        onClick={handleBack}
      />
      <h3 className="font-bold text-2xl text-left mt-1">Resumen final</h3>
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
        {totalPrice === 0 ? (
          <div className="w-full flex flex-col">
            <h3 className="font-bold text-base">Cambio de productos</h3>
            <p className="text-black text-sm mt-2">
              <span className="font-bold">
                Una vez devuelvas tus productos,
              </span>{" "}
              recibirás los nuevos que has seleccionado.{" "}
              {totalPrice2 && (
                <p className="font-bold">
                  Recibirás un link para proceder con el pago de{" "}
                  {-totalPrice2.toFixed(2)} € cuando se acepte tu devolución.
                </p>
              )}
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

export const LastWindow = memo(LastWindowBase);
