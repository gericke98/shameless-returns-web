"use client";
import { useMemo, useState, useTransition } from "react";
import { ClientOrderProps } from "@/types";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { ContinueButton } from "./components/buttons/nextButton";
import { OrderWindow } from "./windows/orderWindow";
import { Header } from "./windows/header";
import { useT } from "@/lib/i18n/context";

export const ClientOrder = ({
  name,
  items,
  order,
  id,
  allProducts,
  statusPanel,
}: ClientOrderProps) => {
  const [position, setPosition] = useState<number>(1);
  const [credito, setCredito] = useState<boolean>(true);
  const [isPending, startTransition] = useTransition();
  const t = useT();

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
    <div className="flex min-h-screen flex-col items-center justify-between bg-brand-paper gap-10 pb-20">
      <Header />
      <div className="flex-1 flex items-center justify-center w-full">
        <div className="bg-white-pattern flex flex-col lg:w-[30%] w-[85%] rounded-3xl items-center py-10 px-4 lg:px-6 min-h-[500px]">
          {/* The customer's existing return and its cancel control, above the
              wizard that would start a new one. Inside this card on purpose:
              it is the only styled surface on the page, and a money-moving
              action rendered outside it appeared as an unstyled full-bleed
              strip above the logo. Server-rendered in page.tsx and passed
              down, so eligibility is never decided on the client. */}
          {statusPanel}
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
                text={t.common.updateOrder}
                id={id}
                isCredit={credito}
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
