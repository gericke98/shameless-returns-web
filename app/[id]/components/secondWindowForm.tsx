import { updateData } from "@/actions/updateOrder";
import { FormInput } from "@/components/formInput";
import { orders, productsOrder } from "@/db/schema";
import { useEffect } from "react";
import { useFormState } from "react-dom";
import { SummaryComponent } from "./summary";
import { Product } from "@/types";
type Props = {
  order: typeof orders.$inferSelect;
  position: number;
  setPosition: React.Dispatch<React.SetStateAction<number>>;
  items: (typeof productsOrder.$inferSelect & { newp?: Product })[];
};

export const SecondWindowForm = ({
  order,
  position,
  setPosition,
  items,
}: Props) => {
  const [state, formAction] = useFormState(updateData, position);
  const totalPriceDevolver = items
    .filter((item) => item.action && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const totalPriceCambio = items
    .filter((item) => item.action === "CAMBIO" && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);
  const totalPrice = totalPriceDevolver - totalPriceCambio;
  useEffect(() => {
    if (state !== 2) {
      if (totalPrice !== 0) {
        setPosition(state);
      } else {
        setPosition(state + 1);
      }
    }
  }, [state]);
  return (
    <form className="mt-10 w-full flex flex-col gap-8" action={formAction}>
      <input hidden name="id" value={order.id} />
      <FormInput
        name="name"
        title="Nombre"
        valueini={order.shippingName}
        icon={false}
      />
      <FormInput
        name="address"
        title="Calle y número"
        valueini={order.shippingAddress1}
        icon={false}
      />
      <FormInput
        name="address2"
        title="Apartamento, local, etc (Opcional)"
        valueini={
          order.shippingAddress2?.toString() === "No information provided"
            ? ""
            : order.shippingAddress2?.toString()
        }
        icon={false}
      />
      <FormInput
        name="zip"
        title="Código postal"
        valueini={order.shippingZip?.toString()}
        icon={false}
      />
      <FormInput
        name="city"
        title="Ciudad"
        valueini={order.shippingCity?.toString()}
        icon={false}
      />
      <FormInput
        name="province"
        title="Provincia"
        valueini={order.shippingProvince?.toString()}
        icon={false}
      />
      <FormInput
        name="country"
        title="País"
        valueini={order.shippingCountry?.toString()}
        icon={false}
      />
      <FormInput
        name="phone"
        title="Teléfono"
        valueini={order.shippingPhone?.toString()}
        icon={false}
      />
      <span className="border w-full border-gray-300 mt-2" />
      {items.some((item) => item.action !== null) && (
        <SummaryComponent items={items} shipping={true} final={false} />
      )}
      <button
        type="submit"
        className="bg-cyan-800 py-4 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      >
        Continuar
      </button>
    </form>
  );
};
