"use client";

import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";

const ShippingTitle = () => {
  const t = useT();
  return (
    <h6 className="text-sm tracking-wide font-light">{t.summary.shipping}</h6>
  );
};

// Previously `- {shippingCost}.00 €`, which hardcoded the decimals: a 4.50 fee
// rendered as "4.5.00 €". formatEuros also gets the separator right per locale.
const ShippingCost = ({ shippingCost }: { shippingCost: number }) => {
  const locale = useLocale();
  return (
    <h6 className="text-sm font-light">- {formatEuros(shippingCost, locale)}</h6>
  );
};

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
