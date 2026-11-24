import { OrderWindowContentProps } from "@/types";
import { FirstWindow } from "./firstWindow";
import { SecondWindow } from "./secondWindow";
import { ThirdWindow } from "./thirdWindow";
import { LastWindow } from "./lastWindow";
import { usePortalWizard } from "../wizardContext";

/**
 * One window per step, chosen by NAME from the wizard's derived step. There is
 * no position arithmetic and no effect resetting it: an empty selection, a
 * payout step that no longer applies, and a summary reached without a required
 * payout are all resolved by `currentStep` (lib/portalWizard) before render.
 */
export const OrderWindowContent = ({
  name,
  items,
  order,
  id,
  onItemChange,
  allProducts,
}: OrderWindowContentProps) => {
  const { step } = usePortalWizard();

  switch (step) {
    case "items":
      return (
        <FirstWindow
          name={name}
          items={items}
          onItemChange={onItemChange}
          allProducts={allProducts}
        />
      );
    case "address":
      return (
        <SecondWindow
          order={order}
          items={items}
          onItemChange={onItemChange}
          id={id}
          allProducts={allProducts}
        />
      );
    case "payout":
      return <ThirdWindow />;
    case "summary":
      return (
        <LastWindow
          items={items}
          onItemChange={onItemChange}
          id={id}
          allProducts={allProducts}
        />
      );
  }
};
