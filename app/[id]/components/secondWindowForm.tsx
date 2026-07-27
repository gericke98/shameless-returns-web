import { updateData } from "@/actions/updateOrder";
import { FormInput } from "@/components/formInput";
import { FormSelect } from "@/components/formSelect";
import { orders, productsOrder } from "@/db/schema";
import { SUPPORTED_COUNTRIES, normalizeCountry } from "@/lib/countries";
import { useEffect } from "react";
import { useFormState } from "react-dom";
import { SummaryComponent } from "../components/summary/summary";
import { Product } from "@/types";
import { useFees } from "../feesContext";
import { centsToEuros, resolveFee } from "@/lib/fees";

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
  // useFormState returns [state, formAction]
  const [state, formAction] = useFormState(updateData, position);

  const totalPriceDevolver = items
    .filter((item) => item.action && !item.confirmed)
    .reduce((sum, item) => sum + parseFloat(item.price), 0);

  const totalPriceCambio = items
    .filter((item) => item.action === "CAMBIO" && !item.confirmed)
    .reduce((sum, item) => {
      // If there's a new variant ID, find the corresponding product and use its price
      if (item.new_variant_id) {
        const newProduct = allProducts.find((p) =>
          p.variants.edges.some((v) => v.node.id === item.new_variant_id)
        );
        if (newProduct) {
          // Find the specific variant that matches the new_variant_id
          const newVariant = newProduct.variants.edges.find(
            (v) => v.node.id === item.new_variant_id
          );
          if (newVariant) {
            return sum + parseFloat(newVariant.node.price);
          }
        }
      }
      // Fallback to the original price if no new product is found
      return sum + parseFloat(item.price);
    }, 0);

  const totalPriceAux = totalPriceDevolver - totalPriceCambio;
  const fees = useFees();
  const { feeCents } = resolveFee(fees, {
    hasItems: items.some((item) => item.action && !item.confirmed),
    netAmount: totalPriceAux,
  });
  const totalPrice = totalPriceAux - centsToEuros(feeCents);

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
    <form className="mt-10 w-full flex flex-col gap-8" onSubmit={handleSubmit}>
      <input hidden name="id" value={order.id} readOnly />
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
      <FormSelect
        name="country"
        title="País"
        options={SUPPORTED_COUNTRIES.map((c) => ({
          value: c.code,
          label: c.nameEs,
        }))}
        valueini={normalizeCountry(order.shippingCountry) ?? "ES"}
        required
      />
      <FormInput
        name="phone"
        title="Teléfono"
        valueini={order.shippingPhone?.toString()}
        icon={false}
      />
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
        className="bg-cyan-800 py-4 lg:-my-8 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full text-white font-bold"
      >
        Continuar
      </button>
    </form>
  );
};
