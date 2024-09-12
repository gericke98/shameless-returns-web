"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import Image from "next/image";
import { FormProduct } from "../form";
import { Product, Product2 } from "@/types";
import { productsOrder } from "@/db/schema";
import { cn } from "@/lib/utils";
import { LiaExchangeAltSolid } from "react-icons/lia";
import { IoIosReturnLeft } from "react-icons/io";
import { useState } from "react";

type Props = {
  orderProduct: typeof productsOrder.$inferSelect;
  product: Product2;
};

export const ProductLineClient = ({ orderProduct, product }: Props) => {
  const [changed, setChanged] = useState<boolean>(false);
  return (
    <div
      className={cn(
        "w-full p-2 hover:bg-white hover:cursor-pointer",
        orderProduct.confirmed && "pointer-events-none cursor-none"
      )}
    >
      <Dialog>
        <DialogTrigger className="w-full flex flex-row flex-nowrap gap-4">
          <Image
            alt={product.image.src}
            src={product.image.src}
            width={100}
            height={140}
            className="rounded-xl"
          />
          <div className="flex flex-col w-full gap-1 items-start">
            <h3 className="lg:text-base text-sm text-left font-bold leading-tight text-black">
              {orderProduct.title}
            </h3>
            <div className="w-full flex flex-row gap-3">
              <h5
                className={cn(
                  "text-xs text-left font-normal text-slate-700",
                  orderProduct.changed && "line-through"
                )}
              >
                {orderProduct.variant_title}
              </h5>
              {orderProduct.changed && (
                <h5 className="text-xs text-left font-normal text-slate-700">
                  {orderProduct.new_variant_title}
                </h5>
              )}
            </div>
            <h4 className="text-sm text-left font-bold leading-tight text-black">
              {orderProduct.price} €
            </h4>
            {orderProduct.action && (
              <div className="flex flex-col justify-center gap-1 w-full">
                <div className="w-full h-5 flex flex-row items-center justify-center bg-blue-100 rounded-md max-w-24">
                  {orderProduct.action === "CAMBIO" ? (
                    <LiaExchangeAltSolid size={11} />
                  ) : (
                    <IoIosReturnLeft size={11} />
                  )}
                  <h5 className="text-xs font-light text-left align-text-middle px-2 flex-none">
                    {orderProduct.action.charAt(0) +
                      orderProduct.action.slice(1).toLowerCase()}
                  </h5>
                </div>
                <h5 className="text-xs font-light italic rounded-md text-left">
                  &quot;{orderProduct.reason}&quot;
                </h5>
              </div>
            )}
            {orderProduct.confirmed && (
              <h5 className="text-xs font-bold text-left px-1 py-2 flex-none bg-blue-200 rounded-md">
                El producto ya ha sido modificado
              </h5>
            )}
          </div>
        </DialogTrigger>
        <DialogContent className="my-10 max-w-96 max-h-screen overflow-scroll lg:mx-0 mx-2">
          <DialogHeader>
            <DialogTitle>
              <h5 className="text-2xl font-bold mt-8 mb-8">Selección</h5>
            </DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <ScrollArea className="flex flex-col w-full items-start">
              <div className="w-full flex flex-row flex-nowrap gap-4">
                <Image
                  alt={product.image.src}
                  src={product.image.src}
                  width={100}
                  height={100}
                  className="rounded-xl"
                />
                <div className="flex flex-col w-full gap-1 items-start">
                  <h3 className="text-base font-bold leading-tight text-black">
                    {orderProduct.title}
                  </h3>
                  <h5 className="text-xs font-normal text-slate-700">
                    {orderProduct.variant_title}
                  </h5>
                  <h4 className="text-sm font-bold leading-tight text-black">
                    {orderProduct.price} €
                  </h4>
                </div>
              </div>
              <div className="w-full mt-2 max-h-full">
                <FormProduct
                  product={product}
                  orderProduct={orderProduct}
                  changed={changed}
                  setChanged={setChanged}
                />
              </div>
            </ScrollArea>
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </div>
  );
};
