import { saveAddress } from "@/actions/address";
import { sharedRefusalKey, useCallAction } from "@/lib/callAction";
import { FormInput } from "@/components/formInput";
import { orders, productsOrder } from "@/db/schema";
import { countryDisplayName } from "@/lib/countries";
import { useState, useTransition } from "react";
import { SummaryComponent } from "../components/summary/summary";
import { Product } from "@/types";
import { useLocale, useT } from "@/lib/i18n/context";
import { DeliveryAddressFields } from "./deliveryAddressFields";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import { ACTIONS } from "@/placeholder";
import { cn } from "@/lib/utils";
import { usePortalWizard } from "../wizardContext";

type Props = {
  order: typeof orders.$inferSelect;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  allProducts: Product[];
};

export const SecondWindowForm = ({
  order,
  items,
  allProducts,
}: Props) => {
  const t = useT();
  const locale = useLocale();
  const wizard = usePortalWizard();
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const callAction = useCallAction();

  // Only an exchange has a replacement to deliver. A pure return must not be
  // offered a delivery address: there is nothing to send, and the outbound leg
  // it would price is zero.
  //
  // ACTIONS.CHANGE, never the literal "CAMBIO" and never the dropdown's label:
  // productsorder.action stores the stable code, and comparing against the
  // localized text is what once made an English exchange save as a return.
  // `!confirmed` matches the filter valueBasket already uses — a line
  // already submitted on an earlier pass is not part of this basket.
  const hasExchange = items.some(
    (item) => item.action === ACTIONS.CHANGE && !item.confirmed
  );

  // The save runs from the submit EVENT, and the wizard moves on only when it
  // reports success. This used to be useFormState returning `prevState + 1`
  // and an effect copying that number into the step: React queues a repeated
  // submit with the previous result as its prevState, so a double-tap counted
  // 2 → 3 → 4 and skipped the payout step (#312875). Now the button is
  // disabled while saving, and even a save that slips through lands on the
  // same step — `addressSaved` is idempotent.
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isPending) return;
    const form = new FormData(e.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "");
    const optional = (key: string) => (form.has(key) ? text(key) : undefined);
    const deliveryBlockOffered = form.has("deliveryBlockOffered");
    // All seven empty means "no separate delivery address"; anything else is
    // sent as typed, and the server's all-or-nothing parse judges it.
    const deliveryKeys = ["deliveryName", "deliveryAddress1", "deliveryAddress2", "deliveryZip", "deliveryCity", "deliveryProvince", "deliveryCountry"];
    const delivery =
      deliveryBlockOffered && deliveryKeys.some((k) => text(k).trim().length > 0)
        ? {
            name: text("deliveryName"),
            address1: text("deliveryAddress1"),
            address2: optional("deliveryAddress2"),
            zip: text("deliveryZip"),
            city: text("deliveryCity"),
            province: optional("deliveryProvince"),
            country: text("deliveryCountry"),
          }
        : null;
    setSaveError(null);
    startTransition(async () => {
      const outcome = await callAction(saveAddress, {
        expectedOrderId: order.id,
        name: text("name"),
        address1: text("address"),
        address2: optional("address2"),
        zip: text("zip"),
        city: text("city"),
        province: optional("province"),
        phone: optional("phone"),
        delivery,
        deliveryBlockOffered,
      });
      if (outcome.kind === "unknown") return setSaveError(t.action.notSaved);
      const { result } = outcome;
      if (result.ok) return wizard.addressSaved();
      if (result.reason === "no-session") return;
      if (result.reason === "incomplete") return setSaveError(t.action.incomplete);
      if (result.reason === "invalid-delivery") return setSaveError(t.action.invalidDelivery);
      if (result.reason === "not-editable") return setSaveError(t.action.notEditable);
      const shared = sharedRefusalKey(result.reason);
      setSaveError(shared ? t.action[shared] : t.second.saveError);
    });
  };

  return (
    <form className="mt-10 w-full flex flex-col gap-4" onSubmit={handleSubmit}>
      <input hidden name="id" value={order.id} readOnly />
      <FormInput
        name="name"
        title={t.second.name}
        valueini={order.shippingName}
        icon={false}
      />
      <FormInput
        name="address"
        title={t.second.address}
        valueini={order.shippingAddress1}
        icon={false}
      />
      <FormInput
        name="address2"
        title={t.second.address2}
        valueini={
          order.shippingAddress2?.toString() === "No information provided"
            ? ""
            : order.shippingAddress2?.toString()
        }
        icon={false}
      />
      <FormInput
        name="zip"
        title={t.second.zip}
        valueini={order.shippingZip?.toString()}
        icon={false}
      />
      <FormInput
        name="city"
        title={t.second.city}
        valueini={order.shippingCity?.toString()}
        icon={false}
      />
      <FormInput
        name="province"
        title={t.second.province}
        valueini={order.shippingProvince?.toString()}
        icon={false}
      />
      {/*
        Country is shown, not chosen. It decides the carrier (Correos vs
        Amphora) and the shipping_fees row, so letting the customer set it
        would both misroute parcels and let them pick their own price. It is
        rendered straight from the stored order — `countryDisplayName` falls
        back to the raw stored string for a country we cannot name, so an
        Andorra order reads "Andorra" rather than being relabelled "España" —
        and `updateData` never reads a `country` field, so there is no form
        value to tamper with. There is deliberately no <input>, hidden or
        otherwise, carrying this value back to the server.
      */}
      <div className="flex flex-col gap-2">
        <span className="text-xs text-slate-600">{t.second.country}</span>
        <p className="w-full p-2 border border-slate-200 rounded-md bg-gray-100 text-slate-700">
          {countryDisplayName(order.shippingCountry, locale)}
        </p>
      </div>
      <FormInput
        name="phone"
        title={t.second.phone}
        valueini={order.shippingPhone?.toString()}
        icon={false}
      />
      {hasExchange && (
        <>
          <span className="border w-full border-gray-300 mt-2" />
          {/*
            Marks that the delivery block was OFFERED this pass, independent
            of whether it was ticked. updateData reads this to decide whether
            to touch the seven delivery_* columns at all — see the comment
            there. Without it, a later pure-return pass (which never renders
            this block) is indistinguishable, at the database, from this
            customer unticking a saved address, and silently wipes it.
          */}
          <input type="hidden" name="deliveryBlockOffered" value="1" />
          <DeliveryAddressFields order={order as unknown as OrderAddressFields} />
        </>
      )}
      <span className="border w-full border-gray-300 mt-2" />
      <div className="rounded-lg">
        <SummaryComponent
          items={items}
          shipping={true}
          final={false}
          allProducts={allProducts}
          method={wizard.method}
        />
      </div>
      {saveError && (
        <p role="alert" className="text-sm text-red-600">
          {saveError}
        </p>
      )}
      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className={cn(
          "bg-white text-black border border-black py-4 lg:-my-8 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold",
          isPending && "opacity-60 cursor-not-allowed"
        )}
      >
        {isPending ? t.common.processing : t.common.continue}
      </button>
    </form>
  );
};
