"use client";
import { useTransition } from "react";
import { ClientOrderProps } from "@/types";
import { AsyncButton } from "@/app/[id]/components/buttons/asyncButton";
import { TrackingCapture } from "@/app/[id]/components/trackingCapture";
import { ContinueButton } from "./components/buttons/nextButton";
import { OrderWindow } from "./windows/orderWindow";
import { Header } from "./windows/header";
import { useT } from "@/lib/i18n/context";
import { PortalWizardProvider, usePortalWizard } from "./wizardContext";

export const ClientOrder = (props: ClientOrderProps) => (
  // The wizard (lib/portalWizard) lives here: the lowest common ancestor of
  // the windows that move through it and the buttons below them.
  <PortalWizardProvider items={props.items} allProducts={props.allProducts}>
    <ClientOrderShell {...props} />
  </PortalWizardProvider>
);

const ClientOrderShell = ({
  name,
  items,
  order,
  id,
  allProducts,
  statusPanel,
}: ClientOrderProps) => {
  const wizard = usePortalWizard();
  const [isPending, startTransition] = useTransition();
  const t = useT();

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
            <TrackingCapture id={order.id} orderNumber={order.orderNumber} />
          )}
          {/* Saved but waiting for ops to confirm it with the carrier: from
              the stored state, so it survives a reload (Codex review). */}
          {order.returnSubmittedAt != null &&
            order.trackingSubmittedAt != null &&
            order.trackingVerifiedAt == null && (
              <p className="text-sm font-bold">{t.tracking.pending}</p>
            )}
          <OrderWindow
            name={name}
            items={items}
            order={order}
            id={id}
            onItemChange={wizard.itemChanged}
            allProducts={allProducts}
          />
          <div className="w-full mt-4">
            {wizard.step === "summary" ? (
              <AsyncButton
                text={t.common.updateOrder}
                id={id}
                // Never a default (#312385): null only when nothing comes back,
                // which is the one case the server accepts it.
                isCredit={wizard.payout === null ? null : wizard.payout === "credit"}
                email={order.email}
                method={wizard.method}
                disabled={!wizard.canSubmit}
                onPayoutRefused={wizard.payoutRefused}
              />
            ) : wizard.step === "address" ? null : (
              // The address step submits its own form (SecondWindowForm).
              <ContinueButton
                visible={wizard.canContinue}
                onClick={() => startTransition(() => wizard.next())}
                isPending={isPending}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
