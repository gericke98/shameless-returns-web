"use client";

import { memo, useEffect } from "react";
import { Progress } from "@/components/ui/progress";
import { FaArrowAltCircleLeft } from "react-icons/fa";
import Image from "next/image";
import { cn } from "@/lib/utils";
import RegaloWhite from "@/public/giftWhite.svg";
import RegaloBlack from "@/public/giftBlack.svg";
import CardWhite from "@/public/cardWhite.svg";
import CardBlack from "@/public/cardBlack.svg";
import { creditTotal } from "@/lib/agreement";
import { usePortalWizard } from "../wizardContext";
import { useLocale, useT } from "@/lib/i18n/context";
import { formatEuros, type Dictionary, type Locale } from "@/lib/i18n";

// Reusable sub-component for Store Credit.
// `t` and `locale` arrive as props, for consistency with sibling components
// declared at module scope.
const StoreCredit = ({
  totalPrice,
  isSelected,
  onClick,
  t,
  locale,
}: {
  totalPrice: number;
  isSelected: boolean;
  onClick: () => void;
  t: Dictionary;
  locale: Locale;
}) => (
  <div
    className={cn(
      "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer transition-colors",
      isSelected ? "bg-shameless-orange" : "bg-white border border-gray-300"
    )}
    onClick={onClick}
  >
    <div className="w-full flex flex-row gap-2">
      <Image
        src={isSelected ? RegaloWhite : RegaloBlack}
        alt="Icon regalo"
        width={50}
        height={30}
        className={cn(
          "rounded-full p-2 my-1",
          isSelected ? "bg-teal-700" : "bg-teal-200"
        )}
      />
      <div className="w-full flex flex-col items-start justify-center">
        <h3
          className={cn(
            "font-bold text-lg",
            isSelected ? "text-white" : "text-black"
          )}
        >
          {t.third.storeCredit}
        </h3>
        <p className="bg-cyan-400 text-xs w-24 p-1 rounded-full font-bold text-center text-black">
          {t.third.storeCreditBadge}
        </p>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      {t.third.storeCreditBody}
    </p>
    <span
      className={cn(
        "border-b w-full mt-1",
        isSelected ? "border-white" : "border-black"
      )}
    />
    <p
      className={cn(
        "text-sm font-bold",
        isSelected ? "text-white" : "text-black"
      )}
    >
      {t.third.totalRefund}: {formatEuros(totalPrice, locale)}
    </p>
  </div>
);

// Reusable sub-component for Original Payment.
// `t` and `locale` are props, same as StoreCredit, for consistency with
// sibling components declared at module scope.
const OriginalPayment = ({
  totalPrice,
  isSelected,
  onClick,
  t,
  locale,
}: {
  totalPrice: number;
  isSelected: boolean;
  onClick: () => void;
  t: Dictionary;
  locale: Locale;
}) => (
  <div
    className={cn(
      "rounded-xl w-full flex flex-col p-3 gap-3 cursor-pointer transition-colors",
      isSelected ? "bg-shameless-orange" : "bg-white border border-gray-300"
    )}
    onClick={onClick}
  >
    <div className="w-full flex flex-row gap-2">
      <Image
        src={isSelected ? CardWhite : CardBlack}
        alt="Icon tarjeta"
        width={50}
        height={30}
        className={cn(
          "rounded-full p-2 my-1",
          isSelected ? "bg-teal-700" : "bg-teal-200"
        )}
      />
      <div className="w-full flex flex-col items-start justify-center">
        <h3
          className={cn(
            "font-bold text-lg",
            isSelected ? "text-white" : "text-black"
          )}
        >
          {t.third.originalPayment}
        </h3>
      </div>
    </div>
    <p className={cn("text-sm", isSelected ? "text-white" : "text-black")}>
      {t.third.originalPaymentBody}
    </p>
    <span
      className={cn(
        "border-b w-full mt-1",
        isSelected ? "border-white" : "border-black"
      )}
    />
    <p
      className={cn(
        "text-sm font-bold",
        isSelected ? "text-white" : "text-black"
      )}
    >
      {t.third.totalRefund}: {formatEuros(totalPrice, locale)}
    </p>
  </div>
);

const ThirdWindowBase = () => {
  const wizard = usePortalWizard();
  const t = useT();
  const locale = useLocale();

  // The cash value coming back, from the same terms the server agrees the
  // submit from (lib/selectionTerms) — including the return method, which the
  // old inline valuation here ignored. Credit is the server's own rounding
  // (creditTotal: 115%, half up, in cents), not `total * 1.15` in floats.
  const netCents = wizard.terms.netCents;
  const refundTotal = netCents / 100;
  const creditTotalEuros = creditTotal(netCents) / 100;
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    // Use a container with max-w to keep things narrow on large screens,
    // but fill the screen on mobile.
    <div className="w-full mx-auto flex flex-col p-2 sm:p-4 mb-3">
      {/* Progress Bar */}
      <Progress value={75} className="mb-2" />

      {/* Back Arrow */}
      <FaArrowAltCircleLeft
        size={25}
        className="mt-2 cursor-pointer"
        onClick={wizard.back}
      />

      {/* Title */}
      <h3 className="font-bold text-xl sm:text-2xl text-left mt-2 mb-4">
        {t.third.title}
      </h3>

      {/* Two reembolso options side by side on large screens, stacked on mobile */}
      <div className="flex flex-col gap-3 w-full">
        <StoreCredit
          totalPrice={creditTotalEuros}
          isSelected={wizard.payout === "credit"}
          onClick={() => wizard.choosePayout("credit")}
          t={t}
          locale={locale}
        />
        <OriginalPayment
          totalPrice={refundTotal}
          isSelected={wizard.payout === "refund"}
          onClick={() => wizard.choosePayout("refund")}
          t={t}
          locale={locale}
        />
      </div>
    </div>
  );
};

export const ThirdWindow = memo(ThirdWindowBase);
