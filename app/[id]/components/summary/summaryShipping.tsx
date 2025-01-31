const ShippingTitle = () => (
  <h6 className="text-sm tracking-wide font-light">Logística</h6>
);

const ShippingCost = () => (
  <h6 className="text-sm font-light">
    - {process.env.NEXT_PUBLIC_SHIPPING_RETURN_COST}.00 €
  </h6>
);

export const SummaryShipping = () => {
  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      <div className="w-full h-full flex flex-row justify-between items-center">
        <ShippingTitle />
        <ShippingCost />
      </div>
    </div>
  );
};
