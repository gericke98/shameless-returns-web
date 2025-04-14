"use client";
import { useState, useMemo, useTransition } from "react";
import { ClientOrderProps } from "@/types";
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

  const handleContinue = () => {
    startTransition(() => {
      setPosition((prev) => prev + 1);
    });
  };

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
