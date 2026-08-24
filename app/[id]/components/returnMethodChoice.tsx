"use client";

import { selfBookingOffered, type ReturnMethod } from "@/lib/returnMethods";
import { useT } from "@/lib/i18n/context";

type Props = {
  value: ReturnMethod;
  onChange: (method: ReturnMethod) => void;
  /** What OUR lane charges for the customer's parcel coming back. */
  returnLegCents: number;
  /** The lane we would use if they do not self-book. */
  ourMethod?: ReturnMethod;
};

/**
 * Renders nothing when our own return leg is free — self-booking could only
 * cost the customer more, and offering it would invite people to pay postage
 * they did not need to pay.
 */
export function ReturnMethodChoice({
  value,
  onChange,
  returnLegCents,
  ourMethod = "CORREOS",
}: Props) {
  const t = useT();
  if (!selfBookingOffered(returnLegCents)) return null;

  return (
    <fieldset className="w-full flex flex-col gap-2 mt-4">
      <legend className="font-bold text-base">{t.method.title}</legend>

      <label className="flex items-start gap-3 border rounded-xl p-3 cursor-pointer">
        <input
          type="radio"
          name="returnMethod"
          checked={value !== "SELF"}
          onChange={() => onChange(ourMethod)}
        />
        <span className="text-sm font-bold">{t.method.ourLabel}</span>
      </label>

      <label className="flex items-start gap-3 border rounded-xl p-3 cursor-pointer">
        <input
          type="radio"
          name="returnMethod"
          checked={value === "SELF"}
          onChange={() => onChange("SELF")}
        />
        <span className="flex flex-col">
          <span className="text-sm font-bold">
            <span>{t.method.selfLabel}</span>{" — "}
            <span className="font-normal">{t.method.free}</span>
          </span>
          <span className="text-xs text-slate-600">{t.method.selfHint}</span>
        </span>
      </label>
    </fieldset>
  );
}
