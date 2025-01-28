"use client";
import Image from "next/image";
import { FormInput } from "../../components/formInput";
import { FormSelect } from "../../components/formSelect";
import { FormSelectSize } from "../../components/formSelectSize";
import { useState } from "react";
import { DialogFooter } from "@/components/ui/dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { Product2 } from "@/types";
import { productsOrder } from "@/db/schema";
import { anularOrder, updateOrder } from "@/actions/updateOrder";
import { ACTIONS, REASONS } from "@/placeholder";

type Props = {
  product: Product2;
  orderProduct: typeof productsOrder.$inferSelect;
  changed: boolean;
  setChanged: React.Dispatch<React.SetStateAction<boolean>>;
};

export const FormProduct = ({
  product,
  orderProduct,
  changed,
  setChanged,
}: Props) => {
  const [action, setAction] = useState<string | null>(
    orderProduct.action === "CAMBIO" ? ACTIONS.CHANGE : ACTIONS.RETURN
  );
  const [motivo, setMotivo] = useState<string>(orderProduct.reason || "");
  const [size, setSize] = useState<string>(
    orderProduct.new_variant_title || orderProduct.variant_title
  );
  const [variantId, setVariantId] = useState<string>(
    orderProduct.new_variant_id || ""
  );

  const handleAnular = async () => {
    await anularOrder(orderProduct.variant_id.toString());
    setAction(null);
    setChanged(!changed);
  };

  const handleSizeChange = (value: string) => {
    const newVariant = product.variants.edges.find(
      (v) => v.node.title === value
    )?.node;
    if (newVariant) {
      setVariantId(newVariant.id);
      setSize(value);
    }
  };

  const sizeStock = product.variants.edges.map((variant) => ({
    title: variant.node.title,
    quantity: variant.node.inventoryQuantity,
  }));

  const showNewProduct = action === ACTIONS.CHANGE && motivo !== "";

  return (
    <>
      <form className="mt-10 w-full flex flex-col gap-5" action={updateOrder}>
        <input hidden name="oldVariantId" value={orderProduct.variant_id} />
        <input hidden name="id" value={orderProduct.id} />
        <input hidden name="variantId" value={variantId} />

        <FormSelect
          name="accion"
          title="Acción a realizar"
          options={[ACTIONS.CHANGE, ACTIONS.RETURN]}
          value={action || "CAMBIO"}
          onChange={setAction}
        />

        <FormSelect
          name="motivo"
          title={
            action === ACTIONS.CHANGE
              ? "Motivo del cambio"
              : "Motivo de la devolución"
          }
          options={REASONS}
          value={motivo}
          onChange={setMotivo}
        />

        <FormInput name="notas" title="Notas" icon={false} valueini="" />

        {showNewProduct && (
          <div className="w-full flex flex-col mt-8 gap-3">
            <h3 className="text-base font-bold">NUEVO PRODUCTO</h3>
            <div className="w-full flex flex-row flex-nowrap gap-3">
              <Image
                alt={product.image.src}
                src={product.image.src}
                width={100}
                height={100}
                className="rounded-xl"
              />
              <div className="flex flex-col w-full gap-1 items-start">
                <h3 className="text-base text-left font-bold leading-tight text-black">
                  {orderProduct.title}
                </h3>
                <h5 className="text-xs text-left font-normal text-slate-700">
                  {size}
                </h5>
                <h4 className="text-sm text-left font-regular leading-tight text-black">
                  {orderProduct.price} €
                </h4>
              </div>
            </div>
            <FormSelectSize
              name="newSize"
              title="Nueva talla"
              options={sizeStock}
              value={size}
              onChange={handleSizeChange}
            />
          </div>
        )}

        <DialogClose asChild>
          <button
            type="submit"
            className="bg-cyan-800 text-white py-3 rounded-full hover:bg-cyan-950 focus:bg-cyan-950 flex items-center justify-center w-full mt-8 font-bold"
          >
            Confirmar selección
          </button>
        </DialogClose>

        <DialogFooter className="w-full"></DialogFooter>
      </form>

      <DialogClose asChild>
        <button
          onClick={handleAnular}
          className="bg-white border border-cyan-800 py-3 rounded-full hover:bg-cyan-800 focus:bg-cyan-800 flex items-center justify-center w-full -mt-2 mb-2 hover:text-white font-bold"
        >
          Anular selección
        </button>
      </DialogClose>
    </>
  );
};
