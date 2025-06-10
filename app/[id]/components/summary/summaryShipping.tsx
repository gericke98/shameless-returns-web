const ShippingTitle = () => (
  <h6 className="text-sm tracking-wide font-light">Logística</h6>
);

const ShippingCost = ({ shippingCost }: { shippingCost: number }) => (
  <h6 className="text-sm font-light">- {shippingCost}.00 €</h6>
);

export const SummaryShipping = ({ shippingCost }: { shippingCost: number }) => {
  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      <div className="w-full h-full flex flex-row justify-between items-center">
        <ShippingTitle />
        <ShippingCost shippingCost={shippingCost} />
      </div>
    </div>
  );
};
