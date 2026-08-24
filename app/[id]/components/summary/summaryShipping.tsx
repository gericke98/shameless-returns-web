"use client";

import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros } from "@/lib/i18n";

// Previously `- {shippingCost}.00 €`, which hardcoded the decimals: a 4.50 fee
// rendered as "4.5.00 €". formatEuros also gets the separator right per locale.
const Line = ({ label, amount }: { label: string; amount: number }) => {
  const locale = useLocale();
  return (
    <div className="w-full h-full flex flex-row justify-between items-center">
      <h6 className="text-sm tracking-wide font-light">{label}</h6>
      <h6 className="text-sm font-light">- {formatEuros(amount, locale)}</h6>
    </div>
  );
};

/**
 * The shipping the customer is charged, broken into the journeys it pays for.
 *
 * A return is one journey and shows one line. An exchange is two — the
 * customer's parcel back and the replacement out — and shows both, because a
 * single line reading "Shipping 18.20 €" invites exactly the question this
 * answers. The legs come from `resolveFee` and are derived by subtraction, so
 * they add up to precisely the amount charged.
 *
 * An `outboundCost` of 0 means a pure return, not a free delivery, so the
 * second line is omitted rather than rendered as zero. The first line is then
 * labelled plain "Shipping": naming it "Return shipping" when there is no
 * other leg to distinguish it from only raises the question of what the other
 * one would have been.
 *
 * A `returnCost` of 0 is the mirror image, and is what a self-booked return
 * looks like: the customer is paying their own courier for that journey, so
 * there is no line to show. Itemising it at 0.00 would bill them for a leg
 * they arranged themselves.
 */
export const SummaryShipping = ({
  returnCost,
  outboundCost,
}: {
  returnCost: number;
  outboundCost: number;
}) => {
  const t = useT();
  const hasBothLegs = returnCost > 0 && outboundCost > 0;

  return (
    <div className="w-full h-full flex flex-col pl-4 mt-4 gap-2">
      {returnCost > 0 && (
        <Line
          label={hasBothLegs ? t.summary.returnShipping : t.summary.shipping}
          amount={returnCost}
        />
      )}
      {outboundCost > 0 && (
        <Line
          label={hasBothLegs ? t.summary.deliveryShipping : t.summary.shipping}
          amount={outboundCost}
        />
      )}
    </div>
  );
};
