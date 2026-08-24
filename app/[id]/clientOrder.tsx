"use client";
import { useMemo, useState, useTransition } from "react";
import { ClientOrderProps } from "@/types";
import type { ReturnMethod } from "@/lib/returnMethods";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { TrackingCapture } from "@/app/[id]/components/trackingCapture";
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
  // Lowest common ancestor of ReturnMethodChoice (inside LastWindow) and
  // AsyncButton, which are siblings under this component. "CORREOS" matches
  // what AsyncButton effectively sent before self-booking existed.
  const [method, setMethod] = useState<ReturnMethod>("CORREOS");
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
          {/* Gated on the two facts that actually describe "a self-booked
              return is waiting for its tracking number", not on the lane alone.
              `returnMethod` is written BEFORE the Stripe redirect and is not
              evidence a return exists: a customer who abandoned checkout would
              otherwise be shown this panel forever, and `submitReturnTracking`
              would accept the submission (it only checks the lane), writing
              tracking onto an order with no return and firing an
              `approveAmphoraReturn` 404 into a false ops alert. */}
          {order.returnSubmittedAt != null && order.trackingSubmittedAt == null && (
            <TrackingCapture id={order.id} />
          )}
          <OrderWindow
            position={position}
            name={name}
            items={items}
            order={order}
            id={id}
            setPosition={setPosition}
            credito={credito}
            setCredito={setCredito}
            method={method}
            setMethod={setMethod}
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
                method={method}
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
