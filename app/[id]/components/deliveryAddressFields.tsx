"use client";

import { useState, useEffect, useMemo } from "react";
import { FormInput } from "@/components/formInput";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { useLocale, useT } from "@/lib/i18n/context";
import { useDeliveryDraft } from "../feesContext";
import { parseDeliveryInput } from "@/lib/deliveryAddressInput";
import {
  deliveryAddressOf,
  hasSeparateDelivery,
  type OrderAddressFields,
} from "@/lib/deliveryAddress";

/**
 * "Deliver my replacement somewhere else."
 *
 * Rendered only when the basket contains an exchange; a pure return has no
 * replacement to deliver, and offering the choice there would let a customer
 * raise their own price for nothing.
 *
 * Collapsed, it renders NO inputs at all — not hidden ones. `updateData`
 * writes null for every delivery column when the block is absent, so an
 * unticked box is what clears a previously stored address. Hidden inputs would
 * keep submitting it.
 *
 * The country is a <select> over SUPPORTED_COUNTRIES rather than free text,
 * because it sets the outbound leg's price. `parseDeliveryInput` enforces the
 * same restriction server-side; this is convenience, not the control.
 */
export const DeliveryAddressFields = ({ order }: { order: OrderAddressFields }) => {
  const t = useT();
  const locale = useLocale();
  const { setDraft } = useDeliveryDraft();
  // Reopen already-ticked if the customer saved one on a previous pass.
  const [open, setOpen] = useState(() => hasSeparateDelivery(order));
  const stored = hasSeparateDelivery(order) ? deliveryAddressOf(order) : null;

  const [fields, setFields] = useState<Record<string, string>>(() => ({
    deliveryName: stored?.name ?? order.shippingName ?? "",
    deliveryAddress1: stored?.address1 ?? "",
    deliveryAddress2: stored?.address2 ?? "",
    deliveryZip: stored?.zip ?? "",
    deliveryCity: stored?.city ?? "",
    deliveryProvince: stored?.province ?? "",
    deliveryCountry: stored?.country ?? "",
  }));

  // Sorted by the name the customer actually reads, not by ISO code: an
  // alphabetical list of codes puts Austria under "AT" and Australia under
  // "AU", which is navigable only if you already know the code.
  const countryOptions = useMemo(
    () =>
      SUPPORTED_COUNTRIES.map((c) => ({
        code: c.code,
        label: locale === "es" ? c.nameEs : c.nameEn,
      })).sort((a, b) => a.label.localeCompare(b.label, locale)),
    [locale]
  );

  // Keep the price on screen tracking what is typed. Only a COMPLETE, valid
  // block moves the price — a half-filled one would otherwise flicker the
  // total through whatever country happened to be selected first.
  useEffect(() => {
    if (!open) {
      setDraft(null);
      return;
    }
    const parsed = parseDeliveryInput(fields);
    setDraft(parsed.ok ? parsed.value : null);
  }, [open, fields, setDraft]);

  const set = (name: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [name]: e.target.value }));

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={open}
          onChange={(e) => setOpen(e.target.checked)}
          className="mt-1"
        />
        <span className="flex flex-col">
          <span className="text-xs sm:text-sm font-semibold">
            {t.second.deliverElsewhere}
          </span>
          <span className="text-xxs sm:text-xs text-gray-600">
            {t.second.deliverElsewhereHint}
          </span>
        </span>
      </label>

      {open && (
        <div className="flex flex-col gap-4 border-l-2 border-shameless-orange pl-3">
          <FormInput
            name="deliveryName"
            title={t.second.name}
            valueini={fields.deliveryName}
            icon={false}
            onChange={set("deliveryName")}
          />
          <FormInput
            name="deliveryAddress1"
            title={t.second.address}
            valueini={fields.deliveryAddress1}
            icon={false}
            onChange={set("deliveryAddress1")}
          />
          <FormInput
            name="deliveryAddress2"
            title={t.second.address2}
            valueini={fields.deliveryAddress2}
            icon={false}
            onChange={set("deliveryAddress2")}
          />
          <FormInput
            name="deliveryZip"
            title={t.second.zip}
            valueini={fields.deliveryZip}
            icon={false}
            onChange={set("deliveryZip")}
          />
          <FormInput
            name="deliveryCity"
            title={t.second.city}
            valueini={fields.deliveryCity}
            icon={false}
            onChange={set("deliveryCity")}
          />
          <FormInput
            name="deliveryProvince"
            title={t.second.province}
            valueini={fields.deliveryProvince}
            icon={false}
            onChange={set("deliveryProvince")}
          />
          <div className="flex flex-col gap-2">
            <label
              htmlFor="deliveryCountry"
              className="text-xs text-slate-600"
            >
              {t.second.deliveryCountry}
            </label>
            <select
              id="deliveryCountry"
              name="deliveryCountry"
              value={fields.deliveryCountry}
              onChange={(e) =>
                setFields((f) => ({ ...f, deliveryCountry: e.target.value }))
              }
              className="w-full p-2 border border-slate-200 rounded-md"
            >
              <option value="" />
              {countryOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
};
