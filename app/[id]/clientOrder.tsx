"use client";
import { useState, useMemo, useTransition } from "react";
import { ClientOrderProps, OrderItem, Prices } from "@/types";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { ContinueButton } from "./components/buttons/nextButton";
import { OrderWindow } from "./windows/orderWindow";
import { Header } from "./windows/header";

export const ClientOrder = ({
  name,
  items,
  order,
  id,
  allProducts,
}: ClientOrderProps) => {
  const [position, setPosition] = useState<number>(1);
  const [credito, setCredito] = useState<boolean>(true);
  const [isPending, startTransition] = useTransition();
  console.log("order", order);

  // Compute a flag whether any item is selected (memoized)
  const hasSelectedItems = useMemo(
    () => items.some((item) => item.action),
    [items]
  );

  // Parent callback to receive updated items from children
  const handleItemChange = (updatedItem: any) => {
    const cambioProduct = updatedItem.products.find(
      (item: any) => item.action === "CAMBIO"
    );
    if (cambioProduct) {
      // Caso de cambio pongo el flag de credito en false
      setCredito(false);
    }
  };
  const calculatePrices = (items: OrderItem[]): Prices => {
    const returnPrice = items
      .filter((item) => item.action && !item.confirmed)
      .reduce((sum, item) => sum + parseFloat(item.price), 0);
    const exchangePrice = items
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
    let totalPrice = returnPrice - exchangePrice;
    const shippingCost =
      totalPrice > 0
        ? Number(process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST)
        : Number(process.env.NEXT_PUBLIC_SHIPPING_EXCHANGE_COST);
    totalPrice -= shippingCost;
    return {
      returnPrice,
      exchangePrice,
      totalPrice: totalPrice,
    };
  };

  const handleContinue = () => {
    startTransition(() => {
      setPosition((prev) => prev + 1);
    });
  };
  const { totalPrice } = useMemo(() => calculatePrices(items), [items]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-between bg-black-pattern gap-10 pb-20">
      <Header />
      <div className="flex-1 flex items-center justify-center w-full">
        <div className="bg-white-pattern flex flex-col lg:w-[30%] w-[85%] rounded-3xl items-center py-10 px-4 lg:px-6 min-h-[500px]">
          <OrderWindow
            position={position}
            name={name}
            items={items}
            order={order}
            id={id}
            setPosition={setPosition}
            credito={credito}
            setCredito={setCredito}
            onItemChange={handleItemChange}
            allProducts={allProducts}
          />
          <div className="w-full mt-4">
            {position >= 4 ? (
              <AsyncButton
                text="Actualizar pedido"
                id={id}
                isCredit={credito}
                totalPrice={totalPrice}
                email={order.email}
              />
            ) : (
              <ContinueButton
                position={position}
                hasChanges={hasSelectedItems}
                onClick={handleContinue}
                isPending={isPending}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
