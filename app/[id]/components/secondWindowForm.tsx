import { updateData } from "@/actions/updateOrder";
import { FormInput } from "@/components/formInput";
import { orders, productsOrder } from "@/db/schema";
import { countryDisplayName } from "@/lib/countries";
import { useEffect } from "react";
import { useFormState } from "react-dom";
import { SummaryComponent } from "../components/summary/summary";
import { Product } from "@/types";
import { useFeeLegs } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";
import { valueBasket } from "@/lib/basket";
import { useLocale, useT } from "@/lib/i18n/context";
import { DeliveryAddressFields } from "./deliveryAddressFields";
import type { OrderAddressFields } from "@/lib/deliveryAddress";
import { ACTIONS } from "@/placeholder";

type Props = {
  order: typeof orders.$inferSelect;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
  onItemChange?: (updatedItem: typeof productsOrder.$inferSelect) => void;
  allProducts: Product[];
};

export const SecondWindowForm = ({
  order,
  position,
  setPosition,
  items,
  onItemChange,
  allProducts,
}: Props) => {
  const t = useT();
  const locale = useLocale();
  // useFormState returns [state, formAction]
  const [state, formAction] = useFormState(updateData, position);

  // Same valuation the server charges from: payments.ts -> loadBasket ->
  // valueBasket, over the RAW catalogue — there is no discounted product
  // list any more; each replacement is priced against the line it replaces
  // (lib/replacementPricing.ts). This used to be a hand-rolled copy of that
  // reduce; the two agreed, but nothing made them keep agreeing.
  const basket = valueBasket(items, allProducts);
  // Only an exchange has a replacement to deliver. A pure return must not be
  // offered a delivery address: there is nothing to send, and the outbound leg
  // it would price is zero.
  //
  // ACTIONS.CHANGE, never the literal "CAMBIO" and never the dropdown's label:
  // productsorder.action stores the stable code, and comparing against the
  // localized text is what once made an English exchange save as a return.
  // `!confirmed` matches the filter orderWindowContent already uses — a line
  // already submitted on an earlier pass is not part of this basket.
  const hasExchange = items.some(
    (item) => item.action === ACTIONS.CHANGE && !item.confirmed
  );
  const legs = useFeeLegs();
  const { feeCents } = resolveFee(legs, basket);
  const totalPrice = basket.netAmount - centsToEuros(feeCents);

  useEffect(() => {
    if (state !== 2) {
      setPosition(totalPrice > 0 ? state : state + 1);
    }
  }, [state, totalPrice, setPosition]);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formAction(formData);
    if (onItemChange) {
      // Cast the order to the expected type.
      onItemChange(order as unknown as typeof productsOrder.$inferSelect);
    }
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
        />
      </div>
      <button
        type="submit"
        className="bg-white text-black border border-black py-4 lg:-my-8 rounded-full hover:bg-gray-100 focus:bg-gray-100 transition-colors flex items-center justify-center w-full font-bold"
      >
        {t.common.continue}
      </button>
    </form>
  );
};
